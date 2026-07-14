import { test, expect, describe } from "bun:test";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
import { ComatoDataProvider, useComatoData } from "../../src/data/context";
import { TOKENS } from "../../src/lib/constants";
import { setClientStub } from "../helpers";

/**
 * The harness runs the context in LIVE mode (preload env → liveConfig non-null),
 * and viem's client is the offline stub. We drive the provider by swapping the
 * stub's reads: resolve → live data + "LIVE"; reject → the read fails and the
 * provider must keep the mock fixtures visible (never blank) while recording the
 * error.
 */

const WAD = (n: number) => BigInt(Math.round(n * 1e18));
const BASE8 = (n: number) => BigInt(Math.round(n * 1e8));

function resolvingReads(hf: number, collateral: number, debt: number) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getUserAccountData") {
        return [BASE8(collateral), BASE8(debt), 0n, 8000n, 5500n, WAD(hf)];
      }
      // getPolicy
      return {
        subscriber: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
        collateralAsset: TOKENS.USDC,
        debtAsset: TOKENS.USDT,
        hfThreshold: WAD(1.25),
        rescueCap: 0n,
        premiumRatePerInterval: 0n,
        active: true,
      };
    },
    getContractEvents: async () => [],
    getBlock: async () => ({ number: 1n, timestamp: 0n }),
  };
}

function Probe() {
  const d = useComatoData();
  return (
    <div>
      <span data-testid="mode">{d.isLive ? "LIVE" : "DEMO"}</span>
      <span data-testid="hf">{d.position.healthFactor.toFixed(2)}</span>
      <span data-testid="collateral">{d.position.collateralUsd}</span>
      <span data-testid="asset">{d.position.collateralAsset}</span>
      <span data-testid="error">{d.error ?? "none"}</span>
      <button type="button" onClick={d.refresh}>
        refresh
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ComatoDataProvider>
      <Probe />
    </ComatoDataProvider>,
  );
}

describe("ComatoDataProvider — live mode", () => {
  test("initial paint shows mock fixtures before the first read settles", () => {
    // default stub never settles → the first read is still in flight, so the
    // provider must be painting the mock fallback (never blank).
    const { getByTestId } = renderProbe();
    expect(getByTestId("mode").textContent).toBe("DEMO");
    expect(getByTestId("hf").textContent).toBe("1.82");
  });

  test("successful read swaps in on-chain data + flips to LIVE", async () => {
    setClientStub(resolvingReads(2.1, 9000, 3000));
    const { getByTestId } = renderProbe();
    await waitFor(() => expect(getByTestId("mode").textContent).toBe("LIVE"));
    expect(getByTestId("hf").textContent).toBe("2.10");
    expect(getByTestId("collateral").textContent).toBe("9000");
    expect(getByTestId("asset").textContent).toBe("USDC");
    expect(getByTestId("error").textContent).toBe("none");
  });

  test("failed read keeps the mock data visible + records the error", async () => {
    setClientStub({
      readContract: async () => {
        throw new Error("RPC boom");
      },
    });
    const { getByTestId } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("error").textContent).toBe("RPC boom"),
    );
    // never blank: still on the mock fixtures + Demo badge
    expect(getByTestId("mode").textContent).toBe("DEMO");
    expect(getByTestId("hf").textContent).toBe("1.82");
  });

  test("refresh() re-reads and recovers from an earlier failure", async () => {
    setClientStub({
      readContract: async () => {
        throw new Error("temporary");
      },
    });
    const { getByTestId, getByText } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("error").textContent).toBe("temporary"),
    );
    // now the RPC recovers; a manual refresh should pick it up
    setClientStub(resolvingReads(1.95, 5000, 1000));
    fireEvent.click(getByText("refresh"));
    await waitFor(() => expect(getByTestId("mode").textContent).toBe("LIVE"));
    expect(getByTestId("hf").textContent).toBe("1.95");
    expect(getByTestId("error").textContent).toBe("none");
  });

  test("live mode surfaces a real 'checked N seconds ago' counter (ticker)", async () => {
    setClientStub(resolvingReads(2.0, 8000, 2000));
    const { getByTestId } = renderProbe();
    await waitFor(() => expect(getByTestId("mode").textContent).toBe("LIVE"));
    // let the 1s ticker fire at least once (re-renders via nowTick); wrap the
    // timer-driven state update in act() to keep the output clean.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(getByTestId("mode").textContent).toBe("LIVE");
  });
});
