import { test, expect, describe, afterEach } from "bun:test";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
import { WalletProvider, useWallet } from "../../src/data/wallet";

/**
 * WalletProvider drives connection state off a mocked `window.ethereum`. We
 * install the provider before render (the provider reads `hasInjectedWallet()`
 * at mount), then exercise connect / switch-chain / wallet events.
 */

interface Handler {
  (method: string, params?: unknown[]): unknown;
}
interface MockProvider {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (e: string, h: (...a: unknown[]) => void) => void;
  removeListener: (e: string, h: (...a: unknown[]) => void) => void;
}

const win = window as unknown as { ethereum?: MockProvider };
const ACC = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const ACC_CS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

function install(handler: Handler) {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const calls: string[] = [];
  win.ethereum = {
    request: async ({ method, params }) => {
      calls.push(method);
      return handler(method, params);
    },
    on: (e, h) => {
      (listeners[e] ??= []).push(h);
    },
    removeListener: () => {},
  };
  return { listeners, calls };
}

afterEach(() => {
  delete win.ethereum;
});

function Probe() {
  const w = useWallet();
  return (
    <div>
      <span data-testid="status">{w.status}</span>
      <span data-testid="supported">{String(w.isSupported)}</span>
      <span data-testid="account">{w.account ?? "none"}</span>
      <span data-testid="celo">{String(w.isCelo)}</span>
      <span data-testid="error">{w.error ?? "none"}</span>
      <button type="button" onClick={w.connect}>
        connect
      </button>
      <button type="button" onClick={w.switchChain}>
        switch
      </button>
      <button type="button" onClick={w.disconnect}>
        disconnect
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <WalletProvider>
      <Probe />
    </WalletProvider>,
  );
}

describe("WalletProvider", () => {
  test("no injected wallet → unsupported", async () => {
    const { getByTestId } = renderProbe();
    expect(getByTestId("status").textContent).toBe("unsupported");
    expect(getByTestId("supported").textContent).toBe("false");
  });

  test("present + no authorized accounts → disconnected", async () => {
    install((m) => (m === "eth_accounts" ? [] : null));
    const { getByTestId } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("disconnected"),
    );
    expect(getByTestId("supported").textContent).toBe("true");
  });

  test("restores an already-authorized session on Celo", async () => {
    install((m) => {
      if (m === "eth_accounts") return [ACC];
      if (m === "eth_chainId") return "0xa4ec";
      return null;
    });
    const { getByTestId } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("connected"),
    );
    expect(getByTestId("account").textContent).toBe(ACC_CS);
    expect(getByTestId("celo").textContent).toBe("true");
  });

  test("connect() prompts and lands connected on Celo", async () => {
    install((m) => {
      if (m === "eth_accounts") return [];
      if (m === "eth_requestAccounts") return [ACC];
      if (m === "eth_chainId") return "0xa4ec";
      return null;
    });
    const { getByTestId, getByText } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("disconnected"),
    );
    fireEvent.click(getByText("connect"));
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("connected"),
    );
    expect(getByTestId("celo").textContent).toBe("true");
  });

  test("connect on a non-Celo chain → connected but isCelo false", async () => {
    install((m) => {
      if (m === "eth_accounts") return [];
      if (m === "eth_requestAccounts") return [ACC];
      if (m === "eth_chainId") return "0x1"; // mainnet
      return null;
    });
    const { getByTestId, getByText } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("disconnected"),
    );
    fireEvent.click(getByText("connect"));
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("connected"),
    );
    expect(getByTestId("celo").textContent).toBe("false");
  });

  test("connect rejection records an error + stays disconnected", async () => {
    install((m) => {
      if (m === "eth_accounts") return [];
      if (m === "eth_requestAccounts") throw new Error("User rejected");
      return null;
    });
    const { getByTestId, getByText } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("disconnected"),
    );
    fireEvent.click(getByText("connect"));
    await waitFor(() =>
      expect(getByTestId("error").textContent).toBe("User rejected"),
    );
    expect(getByTestId("status").textContent).toBe("disconnected");
  });

  test("switchChain() drives wallet_switchEthereumChain", async () => {
    const { calls } = install((m) => {
      if (m === "eth_accounts") return [];
      return null;
    });
    const { getByTestId, getByText } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("disconnected"),
    );
    fireEvent.click(getByText("switch"));
    await waitFor(() =>
      expect(calls).toContain("wallet_switchEthereumChain"),
    );
  });

  test("accountsChanged event updates the account, empty disconnects", async () => {
    const { listeners } = install((m) => {
      if (m === "eth_accounts") return [];
      if (m === "eth_chainId") return "0xa4ec";
      return null;
    });
    const { getByTestId } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("disconnected"),
    );
    act(() => listeners.accountsChanged[0]([ACC]));
    await waitFor(() =>
      expect(getByTestId("account").textContent).toBe(ACC_CS),
    );
    expect(getByTestId("status").textContent).toBe("connected");
    act(() => listeners.accountsChanged[0]([]));
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("disconnected"),
    );
  });

  test("disconnect() clears the local account", async () => {
    install((m) => {
      if (m === "eth_accounts") return [ACC];
      if (m === "eth_chainId") return "0xa4ec";
      return null;
    });
    const { getByTestId, getByText } = renderProbe();
    await waitFor(() =>
      expect(getByTestId("status").textContent).toBe("connected"),
    );
    fireEvent.click(getByText("disconnect"));
    await waitFor(() =>
      expect(getByTestId("account").textContent).toBe("none"),
    );
    expect(getByTestId("status").textContent).toBe("disconnected");
  });
});
