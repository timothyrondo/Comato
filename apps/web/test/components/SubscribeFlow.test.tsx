import { test, expect, describe, beforeEach } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import SubscribeFlow, {
  SubscribeFlowView,
} from "../../src/components/SubscribeFlow";
import { WalletProvider } from "../../src/data/wallet";
import type { WalletState } from "../../src/data/wallet";
import type { VaultView } from "../../src/data/useVault";
import type { Address } from "viem";

/**
 * SubscribeFlowView is a pure function of { wallet, vault }, so every branch is
 * rendered from plain fakes. The imperative handlers (run / borrowMore) are
 * exercised for their no-wallet error path (window.ethereum is absent here, so
 * getWalletClient throws and the UI surfaces the error) — the happy path is
 * covered by lib/vault.test.ts.
 */

const win = window as unknown as { ethereum?: unknown };
beforeEach(() => {
  delete win.ethereum;
});

const ACCOUNT = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" as Address;
const VAULT = "0x0000000000000000000000000000000000000abc" as Address;

function wallet(over: Partial<WalletState> = {}): WalletState {
  return {
    status: "connected",
    isSupported: true,
    account: ACCOUNT,
    chainId: 42220,
    isCelo: true,
    error: null,
    connect: () => {},
    disconnect: () => {},
    switchChain: () => {},
    ...over,
  };
}

function vault(over: Partial<VaultView> = {}): VaultView {
  return {
    ready: true,
    loading: false,
    error: null,
    vault: VAULT,
    hasVault: true,
    fundingStage: "active",
    collateralUsd: 9000,
    debtUsd: 3000,
    hf: 1.8,
    rescueHf: 1.3,
    targetHf: 1.6,
    liquidationHf: 1.0,
    collateralAsset: "CELO",
    debtAsset: "USDC",
    risk: "safe",
    breached: false,
    rescued: false,
    hfTrend: 0,
    refresh: () => {},
    ...over,
  };
}

describe("SubscribeFlowView — wallet gate", () => {
  test("no wallet → unsupported note", () => {
    const { getByText } = render(
      <SubscribeFlowView
        wallet={wallet({ status: "unsupported", isSupported: false, account: null, isCelo: false })}
        vault={vault({ ready: false })}
      />,
    );
    expect(getByText("Protect a live position")).toBeDefined();
    expect(getByText(/No browser wallet detected/)).toBeDefined();
    expect(getByText("No wallet")).toBeDefined();
  });

  test("disconnected → Connect wallet button fires connect()", () => {
    let clicked = 0;
    const { getByText } = render(
      <SubscribeFlowView
        wallet={wallet({ status: "disconnected", account: null, isCelo: false, connect: () => clicked++ })}
        vault={vault({ ready: false })}
      />,
    );
    fireEvent.click(getByText("Connect wallet"));
    expect(clicked).toBe(1);
  });

  test("connecting → shows the connecting chip + label", () => {
    const { getAllByText } = render(
      <SubscribeFlowView
        wallet={wallet({ status: "connecting", account: null, isCelo: false })}
        vault={vault({ ready: false })}
      />,
    );
    expect(getAllByText(/Connecting/).length).toBeGreaterThanOrEqual(1);
  });

  test("wrong network → Switch to Celo fires switchChain()", () => {
    let switched = 0;
    const { getByText } = render(
      <SubscribeFlowView
        wallet={wallet({ isCelo: false, chainId: 1, switchChain: () => switched++ })}
        vault={vault({ ready: false })}
      />,
    );
    expect(getByText("Wrong network")).toBeDefined();
    fireEvent.click(getByText("Switch to Celo"));
    expect(switched).toBe(1);
  });

  test("connected but factory not configured → not-configured note", () => {
    const { getByText } = render(
      <SubscribeFlowView wallet={wallet()} vault={vault({ ready: false })} />,
    );
    expect(getByText(/Vault factory not configured/)).toBeDefined();
  });
});

describe("SubscribeFlowView — wizard (no vault yet)", () => {
  test("renders the three funding steps + primary CTA (defaults to WETH → USDT)", () => {
    const { getByText, getByLabelText } = render(
      <SubscribeFlowView
        wallet={wallet()}
        vault={vault({ fundingStage: "none", vault: null, hasVault: false, debtUsd: 0, collateralUsd: 0 })}
      />,
    );
    expect(getByText("Create your Comato vault")).toBeDefined();
    expect(getByText("Approve & supply WETH")).toBeDefined();
    expect(getByText("Borrow USDT")).toBeDefined();
    expect(getByLabelText("Supply collateral")).toBeDefined();
    expect(getByText("Protect a position")).toBeDefined();
  });

  test("collateral picker: defaults to WETH, selecting USDm rewires the copy", () => {
    const { getByText, queryByText } = render(
      <SubscribeFlowView
        wallet={wallet()}
        vault={vault({ fundingStage: "none", vault: null, hasVault: false, debtUsd: 0, collateralUsd: 0 })}
      />,
    );
    // Default headline collateral is WETH (borrows USDT).
    expect(getByText("Approve & supply WETH")).toBeDefined();
    expect(getByText("Borrow USDT")).toBeDefined();

    // Pick the USDm option → collateral + debt copy both change (USDm → USDC).
    fireEvent.click(getByText("USDm"));
    expect(getByText("Approve & supply USDm")).toBeDefined();
    expect(getByText("Borrow USDC")).toBeDefined();
    expect(queryByText("Approve & supply WETH")).toBeNull();
  });

  test("collateral picker is hidden once a vault exists (collateral fixed at creation)", () => {
    // Vault created (awaiting collateral) with USDT terms → no picker, USDT copy.
    const { getByText, queryByText } = render(
      <SubscribeFlowView
        wallet={wallet()}
        vault={vault({
          fundingStage: "awaiting-collateral",
          collateralAsset: "USDT",
          debtAsset: "USDC",
          debtUsd: 0,
          collateralUsd: 0,
        })}
      />,
    );
    expect(getByText("Approve & supply USDT")).toBeDefined();
    expect(getByText("Borrow USDC")).toBeDefined();
    // The WETH option button is absent because the picker isn't rendered.
    expect(queryByText("WETH")).toBeNull();
  });

  test("clicking Protect a position with no wallet surfaces the error", async () => {
    const { getByText } = render(
      <SubscribeFlowView
        wallet={wallet()}
        vault={vault({ fundingStage: "none", vault: null, hasVault: false, debtUsd: 0, collateralUsd: 0 })}
      />,
    );
    fireEvent.click(getByText("Protect a position"));
    await waitFor(() =>
      expect(getByText("No browser wallet detected")).toBeDefined(),
    );
    expect(getByText("Try again")).toBeDefined();
  });
});

describe("SubscribeFlowView — live vault", () => {
  test("safe position → protected chip + all-clear banner + borrow-more", () => {
    const { getByText } = render(
      <SubscribeFlowView wallet={wallet()} vault={vault()} />,
    );
    expect(getByText("Protected by Comato")).toBeDefined();
    expect(getByText(/All clear/)).toBeDefined();
    expect(getByText("Borrow more USDC")).toBeDefined();
  });

  test("breached → deleveraging banner", () => {
    const { getByText } = render(
      <SubscribeFlowView
        wallet={wallet()}
        vault={vault({ hf: 1.15, risk: "warn", breached: true })}
      />,
    );
    expect(getByText(/deleveraging your position/)).toBeDefined();
  });

  test("rescued → recovery banner", () => {
    const { getByText } = render(
      <SubscribeFlowView
        wallet={wallet()}
        vault={vault({ hf: 1.55, rescued: true })}
      />,
    );
    expect(getByText(/Health Factor recovered to/)).toBeDefined();
  });

  test("borrow more with no wallet surfaces the error", async () => {
    const { getByText } = render(
      <SubscribeFlowView wallet={wallet()} vault={vault()} />,
    );
    fireEvent.click(getByText("Borrow"));
    await waitFor(() =>
      expect(getByText("No browser wallet detected")).toBeDefined(),
    );
  });
});

describe("SubscribeFlow container", () => {
  test("wires the hooks; degrades to the unsupported state with no wallet", () => {
    const { getByText } = render(
      <WalletProvider>
        <SubscribeFlow />
      </WalletProvider>,
    );
    expect(getByText("Protect a live position")).toBeDefined();
    expect(getByText(/No browser wallet detected/)).toBeDefined();
  });
});
