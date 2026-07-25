"use strict";
// ---------------------------------------------------------------------------
// Invoice Types
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProposalStatus = exports.ProposalAction = void 0;
// ---------------------------------------------------------------------------
// Governance Types
// ---------------------------------------------------------------------------
var ProposalAction;
(function (ProposalAction) {
    /** Update the protocol fee, in basis points. */
    ProposalAction[ProposalAction["UpdateProtocolFee"] = 0] = "UpdateProtocolFee";
    /** Update the minimum payer reputation required to submit an invoice. */
    ProposalAction[ProposalAction["UpdateMinReputation"] = 1] = "UpdateMinReputation";
    /** Update the oracle contract address (value is an address index/handle). */
    ProposalAction[ProposalAction["UpdateOracle"] = 2] = "UpdateOracle";
    /** Pause the contract (proposedValue ignored). */
    ProposalAction[ProposalAction["PauseContract"] = 3] = "PauseContract";
    /** Unpause the contract (proposedValue ignored). */
    ProposalAction[ProposalAction["UnpauseContract"] = 4] = "UnpauseContract";
    /** Update the default grace period, in seconds. */
    ProposalAction[ProposalAction["UpdateGracePeriod"] = 5] = "UpdateGracePeriod";
})(ProposalAction || (exports.ProposalAction = ProposalAction = {}));
var ProposalStatus;
(function (ProposalStatus) {
    ProposalStatus["Active"] = "Active";
    ProposalStatus["Passed"] = "Passed";
    ProposalStatus["Rejected"] = "Rejected";
    ProposalStatus["Executed"] = "Executed";
})(ProposalStatus || (exports.ProposalStatus = ProposalStatus = {}));
//# sourceMappingURL=index.js.map