const path = require("path");

const asset = (name) => path.join(__dirname, "..", "assets", "payments", name);

module.exports = {
  usdt_trc20: {
    label: "USDT (TRC20)",
    network: "TRON (TRC20)",
    address: "TE2Lz1WE3RcC2sXdizza8vfQCnAfQPWh5M",
    image: asset("usdt_trc20_qr.png")
  },
  usdc_erc20: {
    label: "USDC (ERC20)",
    network: "Ethereum (ERC20)",
    address: "0x7DC0026Ae4d6399cA437F9B6AEC67ce7322A241d",
    image: asset("usdc_erc20_qr.png")
  },
  sol: {
    label: "SOL",
    network: "Solana",
    address: "2fG24ArbujVL5LcLGhKZiWWcKtsXD64KpvdNmDK2pVuQ",
    image: asset("sol_qr.png")
  },
  ltc: {
    label: "LTC",
    network: "Litecoin",
    address: "ltc1qe766z73y52cuhy3sdxfvryydrqfrg2fc48z7d3",
    image: asset("ltc_qr.png")
  },
  eth: {
    label: "ETH",
    network: "Ethereum",
    address: "0x7DC0026Ae4d6399cA437F9B6AEC67ce7322A241d",
    image: asset("eth_qr.png")
  },
  dai_erc20: {
    label: "DAI (ERC20)",
    network: "Ethereum (ERC20)",
    address: "0x7DC0026Ae4d6399cA437F9B6AEC67ce7322A241d",
    image: asset("dai_erc20_qr.png")
  },
  btc: {
    label: "BTC",
    network: "Bitcoin",
    address: "bc1qd6rehz8a80xlrat8c5nhms396fnycna0z9m2q0",
    image: asset("btc_qr.png")
  },
  xrp: {
    label: "XRP",
    network: "XRP Ledger",
    address: "rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV",
    image: asset("xrp_qr.png")
  },
  xmr: {
    label: "XMR",
    network: "Monero",
    address: "85bJXgH1YztJxWDKF6uaX39wWnn5DRTHHJ7gqDLVYXjXVkbiNUoKpfhK5wb51kHRYfPqwXtcTELXuEZa6xHVA5Z79U9cVSA",
    image: asset("xmr_qr.png")
  }
};
