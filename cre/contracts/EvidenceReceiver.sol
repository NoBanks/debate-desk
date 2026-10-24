// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Debate Desk evidence anchor on Ethereum Sepolia.
///
/// The CRE workflow in ../evidence-oracle reads the Chainlink SOL/USD Data Feed and the
/// Coinbase price, then sends a signed report through the Keystone forwarder. This contract
/// accepts reports ONLY from that forwarder, stores the latest values and emits one event per
/// report, so every evidence snapshot the desk debated from has a public, timestamped anchor.
///
/// Self-contained on purpose (no imports) so it compiles with plain solc.

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract EvidenceReceiver is IReceiver {
    error InvalidSender(address sender, address expected);

    event EvidenceAnchored(
        bytes32 indexed reportHash,
        uint256 indexed count,
        int256 chainlinkAnswer,
        uint8 chainlinkDecimals,
        uint64 chainlinkUpdatedAt,
        uint256 coinbaseUsdE8,
        uint32 divergenceBps,
        uint64 generatedAt
    );

    /// The forwarder allowed to deliver reports (the mock forwarder while simulating).
    address public immutable forwarder;

    uint256 public count;
    bytes32 public lastReportHash;
    int256 public lastChainlinkAnswer;
    uint256 public lastCoinbaseUsdE8;
    uint32 public lastDivergenceBps;
    uint64 public lastGeneratedAt;

    constructor(address forwarder_) {
        require(forwarder_ != address(0), "forwarder is zero");
        forwarder = forwarder_;
    }

    function onReport(bytes calldata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        (
            int256 answer,
            uint8 decimals,
            uint64 updatedAt,
            uint256 coinbaseUsdE8,
            uint32 divergenceBps,
            uint64 generatedAt,
            bytes32 reportHash
        ) = abi.decode(report, (int256, uint8, uint64, uint256, uint32, uint64, bytes32));
        count += 1;
        lastReportHash = reportHash;
        lastChainlinkAnswer = answer;
        lastCoinbaseUsdE8 = coinbaseUsdE8;
        lastDivergenceBps = divergenceBps;
        lastGeneratedAt = generatedAt;
        emit EvidenceAnchored(reportHash, count, answer, decimals, updatedAt, coinbaseUsdE8, divergenceBps, generatedAt);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
