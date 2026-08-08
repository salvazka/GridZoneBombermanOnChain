import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  erc20Abi,
  numberToHex,
} from "viem";
import { gridZoneArenaAbi, mockUSDCAbi } from "./abis.js";

/**
 * Wallet + contract access.
 *
 * Every write here passes an explicit `gas`. On Monad the fee is
 * `gas_limit * price`, not `gas_used * price`, so an inflated limit is money out
 * of the user's pocket. It also guards against a wallet whose `eth_estimateGas`
 * call reverts falling back to an enormous default limit, which the user would
 * then be charged for in full.
 */

/**
 * Ceilings, not the values normally used. Each write estimates against the live
 * chain first and only falls back to these if estimation fails. Measured need on
 * Monad testnet: faucet ~62k, approve ~47k, depositEntryFee ~238k.
 */
const GAS_CAP = {
  faucet: 120_000n,
  approve: 100_000n,
  depositEntryFee: 320_000n,
};

/** Headroom over the estimate. Small on purpose: the user pays for the limit. */
const GAS_BUFFER_PCT = 20n;

export class Wallet {
  constructor(appConfig) {
    this.appConfig = appConfig;
    this.chain = defineChain({
      id: appConfig.chainId,
      name: "Monad Testnet",
      nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [appConfig.rpcUrl] } },
      blockExplorers: { default: { name: "MonadScan", url: appConfig.explorerBase } },
      testnet: true,
    });

    // Reads go straight to the RPC, so balances still refresh while the wallet
    // is busy showing a confirmation modal.
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(appConfig.rpcUrl, { retryCount: 3, retryDelay: 400 }),
    });

    this.walletClient = null;
    this.address = null;
    this.provider = undefined;
    this.announcedProviders = [];
    this.listenForProviders();
    this.refreshProvider();
  }

  /**
   * Return injected EIP-1193 providers, preferring MetaMask where more than one
   * extension has injected window.ethereum. MetaMask can inject after Vite has
   * loaded the application, so this must be re-run instead of caching a value
   * during boot.
   */
  static injectedProviders() {
    if (typeof window === "undefined") return [];

    const injected = window.ethereum;
    if (!injected) return [];

    const providers = Array.isArray(injected.providers) ? injected.providers : [injected];
    return providers.filter((provider) => typeof provider?.request === "function");
  }

  static selectProvider(providers) {
    return (
      providers.find((provider) => provider?.isMetaMask === true) ??
      providers.find((provider) => typeof provider?.request === "function")
    );
  }

  /** Listen for late injections and EIP-6963 wallet announcements. */
  listenForProviders() {
    if (typeof window === "undefined") return;

    window.addEventListener("eip6963:announceProvider", (event) => {
      const provider = event.detail?.provider;
      if (
        typeof provider?.request === "function" &&
        !this.announcedProviders.includes(provider)
      ) {
        this.announcedProviders.push(provider);
      }
      this.refreshProvider();
    });

    // Requests announcements from modern wallet extensions, including MetaMask.
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }

  refreshProvider() {
    const provider = Wallet.selectProvider([
      ...Wallet.injectedProviders(),
      ...this.announcedProviders,
    ]);
    if (provider) this.provider = provider;
    return this.provider;
  }

  get isAvailable() {
    return Boolean(this.refreshProvider());
  }

  async connect() {
    const provider = this.refreshProvider();
    if (!provider) {
      throw new Error(
        "MetaMask was not detected. Unlock the extension, reload this page, and try again.",
      );
    }

    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts || accounts.length === 0) throw new Error("No account authorised");

    this.address = accounts[0];
    await this.ensureChain(provider);

    this.walletClient = createWalletClient({
      account: this.address,
      chain: this.chain,
      transport: custom(provider),
    });

    return this.address;
  }

  /** Switches the wallet to Monad testnet, adding it first if unknown. */
  async ensureChain(provider = this.refreshProvider()) {
    if (!provider) throw new Error("No EVM wallet detected.");

    const target = numberToHex(this.appConfig.chainId);
    const current = await provider.request({ method: "eth_chainId" });
    if (current?.toLowerCase() === target.toLowerCase()) return;

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: target }],
      });
    } catch (err) {
      // 4902 = chain not known to the wallet. Anything else is a real failure,
      // most often the user rejecting the prompt.
      if (err?.code === 4902 || err?.data?.originalError?.code === 4902) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: target,
              chainName: "Monad Testnet",
              nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
              rpcUrls: [this.appConfig.rpcUrl],
              blockExplorerUrls: [this.appConfig.explorerBase],
            },
          ],
        });
      } else {
        throw err;
      }
    }
  }

  /**
   * Registers the accountsChanged listener, replacing any previous one.
   *
   * Without tracking and removing the old handler, every successful connect()
   * (e.g. the user disconnects and reconnects, or main.js's own retry path
   * calls connect() again) adds another listener to the injected provider and
   * never removes it. MetaMask's underlying stream multiplexer is a Node-style
   * EventEmitter with the default 10-listener cap, so repeated connects
   * eventually trip "MaxListenersExceededWarning" in the extension's own
   * console — harmless to gameplay, but a real leak worth not causing.
   */
  onAccountsChanged(handler) {
    const provider = this.refreshProvider();
    if (!provider?.on) return;
    if (this._accountsChangedHandler) provider.removeListener?.("accountsChanged", this._accountsChangedHandler);
    this._accountsChangedHandler = handler;
    provider.on("accountsChanged", handler);
  }

  onChainChanged(handler) {
    const provider = this.refreshProvider();
    if (!provider?.on) return;
    if (this._chainChangedHandler) provider.removeListener?.("chainChanged", this._chainChangedHandler);
    this._chainChangedHandler = handler;
    provider.on("chainChanged", handler);
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async readBalances() {
    const [usdc, mon, allowance] = await Promise.all([
      this.publicClient.readContract({
        address: this.appConfig.usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.address],
      }),
      this.publicClient.getBalance({ address: this.address }),
      this.publicClient.readContract({
        address: this.appConfig.usdcAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [this.address, this.appConfig.arenaAddress],
      }),
    ]);
    return { usdc, mon, allowance };
  }

  async isSeated(matchId) {
    return this.publicClient.readContract({
      address: this.appConfig.arenaAddress,
      abi: gridZoneArenaAbi,
      functionName: "isPlayer",
      args: [matchId, this.address],
    });
  }

  // ------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------

  /**
   * Gas limit from a live estimate, buffered and capped.
   *
   * Doing this rather than passing a fixed limit matters on Monad specifically:
   * the fee is `gas_limit * price`, so any slack in the limit is charged to the
   * user. Leaving `gas` unset is worse still, because a wallet whose
   * `eth_estimateGas` reverts may substitute a very large default.
   */
  async _gasFor(call, cap) {
    try {
      const estimate = await this.publicClient.estimateContractGas({
        ...call,
        account: this.address,
      });
      const buffered = estimate + (estimate * GAS_BUFFER_PCT) / 100n;
      return buffered > cap ? cap : buffered;
    } catch {
      return cap;
    }
  }

  async faucet() {
    const call = {
      address: this.appConfig.usdcAddress,
      abi: mockUSDCAbi,
      functionName: "faucet",
      args: [this.address],
    };
    const hash = await this.walletClient.writeContract({
      ...call,
      gas: await this._gasFor(call, GAS_CAP.faucet),
    });
    return this._wait(hash);
  }

  async approveIfNeeded(minimum) {
    const allowance = await this.publicClient.readContract({
      address: this.appConfig.usdcAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.address, this.appConfig.arenaAddress],
    });
    if (allowance >= minimum) return null;

    // Approve a large amount once so joining later matches needs only one
    // signature. PRD §5.1: one approve, one deposit, then zero signatures for
    // the rest of the match.
    const call = {
      address: this.appConfig.usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.appConfig.arenaAddress, 2n ** 255n],
    };
    const hash = await this.walletClient.writeContract({
      ...call,
      gas: await this._gasFor(call, GAS_CAP.approve),
    });
    return this._wait(hash);
  }

  async depositEntryFee(matchId) {
    const call = {
      address: this.appConfig.arenaAddress,
      abi: gridZoneArenaAbi,
      functionName: "depositEntryFee",
      args: [matchId],
    };
    const hash = await this.walletClient.writeContract({
      ...call,
      gas: await this._gasFor(call, GAS_CAP.depositEntryFee),
    });
    return this._wait(hash);
  }

  async _wait(hash) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") {
      throw new Error(`Transaction reverted: ${hash}`);
    }
    return { hash, receipt };
  }

  txUrl(hash) {
    return `${this.appConfig.explorerBase}/tx/${hash}`;
  }
}
