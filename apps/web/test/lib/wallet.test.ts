import { test, expect, describe, afterEach } from "bun:test";
import {
  CELO_CHAIN_ID,
  getInjectedProvider,
  hasInjectedWallet,
  getWalletClient,
  getWalletPublicClient,
  requestAccounts,
  getAuthorizedAccounts,
  getChainId,
  switchToCelo,
  onWalletEvent,
} from "../../src/lib/wallet";

/**
 * The injected-wallet primitives. We mock `window.ethereum` as a minimal
 * EIP-1193 provider (request + on/removeListener) and assert each helper drives
 * the right RPC method. `createPublicClient` is stubbed by the harness, so
 * `getWalletPublicClient` returns the offline stub; `createWalletClient` is real.
 */

interface MockProvider {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (e: string, h: (...a: unknown[]) => void) => void;
  removeListener: (e: string, h: (...a: unknown[]) => void) => void;
}

const win = window as unknown as { ethereum?: MockProvider };

function install(
  handler: (method: string, params?: unknown[]) => unknown,
): { calls: string[]; listeners: Record<string, ((...a: unknown[]) => void)[]>; removed: string[] } {
  const calls: string[] = [];
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const removed: string[] = [];
  win.ethereum = {
    request: async ({ method, params }) => {
      calls.push(method);
      return handler(method, params);
    },
    on: (e, h) => {
      (listeners[e] ??= []).push(h);
    },
    removeListener: (e) => {
      removed.push(e);
    },
  };
  return { calls, listeners, removed };
}

afterEach(() => {
  delete win.ethereum;
});

describe("provider detection", () => {
  test("absent → null / false; present → the provider", () => {
    expect(getInjectedProvider()).toBeNull();
    expect(hasInjectedWallet()).toBe(false);
    install(() => null);
    expect(getInjectedProvider()).not.toBeNull();
    expect(hasInjectedWallet()).toBe(true);
  });
});

describe("account + chain reads", () => {
  test("requestAccounts checksums the returned addresses", async () => {
    install((m) =>
      m === "eth_requestAccounts"
        ? ["0x71c7656ec7ab88b098defb751b7401b5f6d8976f"]
        : null,
    );
    const accounts = await requestAccounts();
    expect(accounts).toEqual(["0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]);
  });

  test("getAuthorizedAccounts returns [] when the provider throws", async () => {
    install((m) => {
      if (m === "eth_accounts") throw new Error("locked");
      return null;
    });
    expect(await getAuthorizedAccounts()).toEqual([]);
  });

  test("getAuthorizedAccounts returns the checksummed set", async () => {
    install((m) =>
      m === "eth_accounts" ? ["0x71c7656ec7ab88b098defb751b7401b5f6d8976f"] : null,
    );
    expect(await getAuthorizedAccounts()).toEqual([
      "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    ]);
  });

  test("getChainId parses the hex chain id", async () => {
    install((m) => (m === "eth_chainId" ? "0xa4ec" : null));
    expect(await getChainId()).toBe(CELO_CHAIN_ID);
  });
});

describe("switchToCelo", () => {
  test("calls wallet_switchEthereumChain when the chain is known", async () => {
    const { calls } = install(() => null);
    await switchToCelo();
    expect(calls).toContain("wallet_switchEthereumChain");
    expect(calls).not.toContain("wallet_addEthereumChain");
  });

  test("adds the chain when the wallet doesn't know it (4902)", async () => {
    const { calls } = install((m) => {
      if (m === "wallet_switchEthereumChain") throw { code: 4902 };
      return null;
    });
    await switchToCelo();
    expect(calls).toContain("wallet_addEthereumChain");
  });

  test("rethrows a non-4902 switch error", async () => {
    install((m) => {
      if (m === "wallet_switchEthereumChain") throw { code: 4001 };
      return null;
    });
    await expect(switchToCelo()).rejects.toBeDefined();
  });
});

describe("onWalletEvent", () => {
  test("registers + tears down account/chain listeners", () => {
    const { listeners, removed } = install(() => null);
    const seenAccounts: string[][] = [];
    const seenChains: string[] = [];
    const off = onWalletEvent(
      (a) => seenAccounts.push(a),
      (c) => seenChains.push(c),
    );
    listeners.accountsChanged[0](["0xabc"]);
    listeners.chainChanged[0]("0xa4ec");
    expect(seenAccounts).toEqual([["0xabc"]]);
    expect(seenChains).toEqual(["0xa4ec"]);
    off();
    expect(removed).toContain("accountsChanged");
    expect(removed).toContain("chainChanged");
  });

  test("no provider → no-op unsubscribe", () => {
    const off = onWalletEvent(
      () => {},
      () => {},
    );
    expect(() => off()).not.toThrow();
  });
});

describe("clients", () => {
  test("getWalletClient needs a provider; returns a signer when present", () => {
    expect(() => getWalletClient()).toThrow("No browser wallet detected");
    install(() => null);
    const wc = getWalletClient();
    expect(typeof wc.writeContract).toBe("function");
  });

  test("getWalletPublicClient returns a read client (offline stub in tests)", () => {
    install(() => null);
    const pc = getWalletPublicClient();
    expect(typeof pc.readContract).toBe("function");
  });
});
