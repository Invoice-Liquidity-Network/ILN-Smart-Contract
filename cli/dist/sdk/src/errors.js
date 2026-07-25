"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ILNError = void 0;
// @ts-nocheck
class ILNError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = this.constructor.name;
    }
    static InvoiceNotFound = class InvoiceNotFound extends ILNError {
        constructor(msg = "Invoice not found") { super(msg, 1); }
    };
    static AlreadyFunded = class AlreadyFunded extends ILNError {
        constructor(msg = "Invoice already funded") { super(msg, 2); }
    };
    static AlreadyPaid = class AlreadyPaid extends ILNError {
        constructor(msg = "Invoice already paid") { super(msg, 3); }
    };
    static NotFunded = class NotFunded extends ILNError {
        constructor(msg = "Invoice not funded") { super(msg, 4); }
    };
    static Unauthorized = class Unauthorized extends ILNError {
        constructor(msg = "Unauthorized") { super(msg, 5); }
    };
    static InvalidAmount = class InvalidAmount extends ILNError {
        constructor(msg = "Invalid amount") { super(msg, 6); }
    };
    static InvalidDiscountRate = class InvalidDiscountRate extends ILNError {
        constructor(msg = "Invalid discount rate") { super(msg, 7); }
    };
    static InvalidDueDate = class InvalidDueDate extends ILNError {
        constructor(msg = "Invalid due date") { super(msg, 8); }
    };
    static InvoiceDefaulted = class InvoiceDefaulted extends ILNError {
        constructor(msg = "Invoice defaulted") { super(msg, 9); }
    };
    static NothingToClaim = class NothingToClaim extends ILNError {
        constructor(msg = "Nothing to claim") { super(msg, 10); }
    };
    static NotYetDefaulted = class NotYetDefaulted extends ILNError {
        constructor(msg = "Not yet defaulted") { super(msg, 11); }
    };
    static OverfundingRejected = class OverfundingRejected extends ILNError {
        constructor(msg = "Overfunding rejected") { super(msg, 12); }
    };
    static InvoiceExpired = class InvoiceExpired extends ILNError {
        constructor(msg = "Invoice expired") { super(msg, 13); }
    };
    static BatchTooLarge = class BatchTooLarge extends ILNError {
        constructor(msg = "Batch too large") { super(msg, 14); }
    };
    static AlreadyCancelled = class AlreadyCancelled extends ILNError {
        constructor(msg = "Already cancelled") { super(msg, 15); }
    };
    static AlreadyInitialized = class AlreadyInitialized extends ILNError {
        constructor(msg = "Already initialized") { super(msg, 16); }
    };
    static AlreadyAppealed = class AlreadyAppealed extends ILNError {
        constructor(msg = "Already appealed") { super(msg, 17); }
    };
    static AppealWindowClosed = class AppealWindowClosed extends ILNError {
        constructor(msg = "Appeal window closed") { super(msg, 18); }
    };
    static NotDefaulted = class NotDefaulted extends ILNError {
        constructor(msg = "Not defaulted") { super(msg, 19); }
    };
    static AlreadyInQueue = class AlreadyInQueue extends ILNError {
        constructor(msg = "Already in queue") { super(msg, 20); }
    };
    static NotApprovedFunder = class NotApprovedFunder extends ILNError {
        constructor(msg = "Not approved funder") { super(msg, 21); }
    };
    static InvoiceAppealed = class InvoiceAppealed extends ILNError {
        constructor(msg = "Invoice appealed") { super(msg, 22); }
    };
    static AlreadyDisputed = class AlreadyDisputed extends ILNError {
        constructor(msg = "Already disputed") { super(msg, 23); }
    };
    static NotDisputed = class NotDisputed extends ILNError {
        constructor(msg = "Not disputed") { super(msg, 24); }
    };
    static InvoiceDisputed = class InvoiceDisputed extends ILNError {
        constructor(msg = "Invoice disputed") { super(msg, 25); }
    };
    static ContractPaused = class ContractPaused extends ILNError {
        constructor(msg = "Contract paused") { super(msg, 26); }
    };
    static DueDateTooSoon = class DueDateTooSoon extends ILNError {
        constructor(msg = "Due date too soon") { super(msg, 27); }
    };
    static DueDateTooFar = class DueDateTooFar extends ILNError {
        constructor(msg = "Due date too far") { super(msg, 28); }
    };
    static SelfInvoice = class SelfInvoice extends ILNError {
        constructor(msg = "Self invoice") { super(msg, 29); }
    };
    static OverpaymentRejected = class OverpaymentRejected extends ILNError {
        constructor(msg = "Overpayment rejected") { super(msg, 30); }
    };
    static PayerReputationTooLow = class PayerReputationTooLow extends ILNError {
        constructor(msg = "Payer reputation too low") { super(msg, 31); }
    };
    static ArithmeticOverflow = class ArithmeticOverflow extends ILNError {
        constructor(msg = "Arithmetic overflow") { super(msg, 32); }
    };
    static FeeOnTransferToken = class FeeOnTransferToken extends ILNError {
        constructor(msg = "Fee on transfer token") { super(msg, 33); }
    };
    static PayerUnverified = class PayerUnverified extends ILNError {
        constructor(msg = "Payer unverified") { super(msg, 34); }
    };
    static OracleDataStale = class OracleDataStale extends ILNError {
        constructor(msg = "Oracle data stale") { super(msg, 35); }
    };
    static AmountTooSmall = class AmountTooSmall extends ILNError {
        constructor(msg = "Amount too small") { super(msg, 36); }
    };
    static InvoiceNotCancellable = class InvoiceNotCancellable extends ILNError {
        constructor(msg = "Invoice not cancellable") { super(msg, 37); }
    };
    static InvalidAddress = class InvalidAddress extends ILNError {
        constructor(msg = "Invalid address") { super(msg, 38); }
    };
    static InvalidTransfer = class InvalidTransfer extends ILNError {
        constructor(msg = "Invalid transfer") { super(msg, 39); }
    };
    static InsufficientAmount = class InsufficientAmount extends ILNError {
        constructor(msg = "Insufficient amount") { super(msg, 999); }
    };
    static fromError(error) {
        const errorString = String(error);
        const match = errorString.match(/Error\(Contract, (\d+)\)/);
        if (match) {
            const code = parseInt(match[1] || "", 10);
            switch (code) {
                case 1: return new ILNError.InvoiceNotFound();
                case 2: return new ILNError.AlreadyFunded();
                case 3: return new ILNError.AlreadyPaid();
                case 4: return new ILNError.NotFunded();
                case 5: return new ILNError.Unauthorized();
                case 6: return new ILNError.InvalidAmount();
                case 7: return new ILNError.InvalidDiscountRate();
                case 8: return new ILNError.InvalidDueDate();
                case 9: return new ILNError.InvoiceDefaulted();
                case 10: return new ILNError.NothingToClaim();
                case 11: return new ILNError.NotYetDefaulted();
                case 12: return new ILNError.OverfundingRejected();
                case 13: return new ILNError.InvoiceExpired();
                case 14: return new ILNError.BatchTooLarge();
                case 15: return new ILNError.AlreadyCancelled();
                case 16: return new ILNError.AlreadyInitialized();
                case 17: return new ILNError.AlreadyAppealed();
                case 18: return new ILNError.AppealWindowClosed();
                case 19: return new ILNError.NotDefaulted();
                case 20: return new ILNError.AlreadyInQueue();
                case 21: return new ILNError.NotApprovedFunder();
                case 22: return new ILNError.InvoiceAppealed();
                case 23: return new ILNError.AlreadyDisputed();
                case 24: return new ILNError.NotDisputed();
                case 25: return new ILNError.InvoiceDisputed();
                case 26: return new ILNError.ContractPaused();
                case 27: return new ILNError.DueDateTooSoon();
                case 28: return new ILNError.DueDateTooFar();
                case 29: return new ILNError.SelfInvoice();
                case 30: return new ILNError.OverpaymentRejected();
                case 31: return new ILNError.PayerReputationTooLow();
                case 32: return new ILNError.ArithmeticOverflow();
                case 33: return new ILNError.FeeOnTransferToken();
                case 34: return new ILNError.PayerUnverified();
                case 35: return new ILNError.OracleDataStale();
                case 36: return new ILNError.AmountTooSmall();
                case 37: return new ILNError.InvoiceNotCancellable();
            }
        }
        return new Error(errorString);
    }
}
exports.ILNError = ILNError;
//# sourceMappingURL=errors.js.map