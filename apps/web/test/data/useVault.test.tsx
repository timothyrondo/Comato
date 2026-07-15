import { test, expect, describe } from "bun:test";
import { render, waitFor, fireEvent } from "@testing-library/react";
import type { Address } from "viem";
import { useVault } from "../../src/data/useVault";
import { TOKENS } from "../../src/lib/constants";
import { ZERO_ADDRESS } from "../../src/lib/vault";
import { setClientStub } from "../helpers";

/**
 * useVault reads the connected wallet's vault via the injected public client —
 * which the harness stubs (`createPublicClient` → offline stub). We drive the
 * stub's `readContract` (branching on functionName) to exercise no-vault, the
 * live position, and the breach → rescue detection across polls.
 */

const WAD = (n: number) => BigInt(Math.round(n * 1e18));
const BASE8 = (n: number) => BigInt(Math.round(n * 1e8));
const ACCOUNT = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" as Address;
const VAULT = "0x0000000000000000000000000000000000000abc" as Address;

function vaultReads(o: {
  vault: string;
  collateral: number;
  debt: number;
  hf: number;
  threshold?: number;
  target?: number;
}) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "vaultOf":
          return o.vault;
        case "position":
          return [BASE8(o.collateral), BASE8(o.debt), WAD(o.hf)];
        case "collateralAsset":
          return TOKENS.CELO;
        case "debtAsset":
          return TOKENS.USDC;
        case "hfThreshold":
          return WAD(o.threshold ?? 1.3);
        case "targetHf":
          return WAD(o.target ?? 1.6);
        case "operator":
          return TOKENS.USDC;
        default:
          return 0n;
      }
    },
  };
}

function Probe({ account, enabled }: { account: Address | null; enabled: boolean }) {
  const v = useVault(account, enabled);
  return (
    <div>
      <span data-testid="ready">{String(v.ready)}</span>
      <span data-testid="hasVault">{String(v.hasVault)}</span>
      <span data-testid="stage">{v.fundingStage}</span>
      <span data-testid="collateral">{v.collateralUsd}</span>
      <span data-testid="debt">{v.debtUsd}</span>
      <span data-testid="hf">{v.hf.toFixed(2)}</span>
      <span data-testid="asset">{v.collateralAsset}</span>
      <span data-testid="risk">{v.risk}</span>
      <span data-testid="breached">{String(v.breached)}</span>
      <span data-testid="rescued">{String(v.rescued)}</span>
      <button type="button" onClick={v.refresh}>
        refresh
      </button>
    </div>
  );
}

describe("useVault", () => {
  test("disabled → not ready, no reads", () => {
    const { getByTestId } = render(<Probe account={ACCOUNT} enabled={false} />);
    expect(getByTestId("ready").textContent).toBe("false");
    expect(getByTestId("hasVault").textContent).toBe("false");
  });

  test("no account → not ready", () => {
    const { getByTestId } = render(<Probe account={null} enabled={true} />);
    expect(getByTestId("ready").textContent).toBe("false");
  });

  test("no vault yet → hasVault false, stage none", async () => {
    setClientStub({ readContract: async () => ZERO_ADDRESS });
    const { getByTestId } = render(<Probe account={ACCOUNT} enabled={true} />);
    await waitFor(() => expect(getByTestId("ready").textContent).toBe("true"));
    expect(getByTestId("hasVault").textContent).toBe("false");
    expect(getByTestId("stage").textContent).toBe("none");
  });

  test("live vault → active stage with mapped collateral/debt/HF/risk", async () => {
    setClientStub(vaultReads({ vault: VAULT, collateral: 9000, debt: 3000, hf: 1.8 }));
    const { getByTestId } = render(<Probe account={ACCOUNT} enabled={true} />);
    await waitFor(() => expect(getByTestId("stage").textContent).toBe("active"));
    expect(getByTestId("hasVault").textContent).toBe("true");
    expect(getByTestId("collateral").textContent).toBe("9000");
    expect(getByTestId("debt").textContent).toBe("3000");
    expect(getByTestId("hf").textContent).toBe("1.80");
    expect(getByTestId("asset").textContent).toBe("CELO");
    expect(getByTestId("risk").textContent).toBe("safe");
    expect(getByTestId("breached").textContent).toBe("false");
  });

  test("breach then recovery flips rescued on the next poll", async () => {
    setClientStub(vaultReads({ vault: VAULT, collateral: 9000, debt: 8000, hf: 1.1 }));
    const { getByTestId, getByText } = render(
      <Probe account={ACCOUNT} enabled={true} />,
    );
    await waitFor(() => expect(getByTestId("breached").textContent).toBe("true"));
    expect(getByTestId("risk").textContent).toBe("warn");

    // Comato deleveraged: HF climbs back above the threshold.
    setClientStub(vaultReads({ vault: VAULT, collateral: 9000, debt: 6000, hf: 1.5 }));
    fireEvent.click(getByText("refresh"));
    await waitFor(() => expect(getByTestId("rescued").textContent).toBe("true"));
    expect(getByTestId("breached").textContent).toBe("false");
  });
});
