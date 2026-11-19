import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EventRepository,
  IngestedEventRecord,
  InvoiceRecord,
  ReputationUpdateRecord,
} from '../src/db/eventRepository.js';
import type {
  DecodedContractEvent,
  HorizonTransactionRecord,
} from '../src/ingestion/eventListener.js';
import { EventListener } from '../src/ingestion/eventListener.js';

class MemoryRepository implements EventRepository {
  state = new Map<string, string>();
  invoices = new Map<number, InvoiceRecord>();
  events: IngestedEventRecord[] = [];
  reputationUpdates: ReputationUpdateRecord[] = [];

  getState(key: string): string | undefined {
    return this.state.get(key);
  }

  setState(key: string, value: string): void {
    this.state.set(key, value);
  }

  getInvoice(id: number): InvoiceRecord | undefined {
    return this.invoices.get(id);
  }

  upsertInvoice(invoice: InvoiceRecord): void {
    this.invoices.set(invoice.id, invoice);
  }

  insertEvent(event: IngestedEventRecord): void {
    this.events.push(event);
  }

  insertReputationUpdate(update: ReputationUpdateRecord): void {
    this.reputationUpdates.push(update);
  }
}

function makeStream(messages: unknown[], signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      const closeStream = () => {
        try {
          controller.close();
        } catch {
          // The stream may already be closed when the abort fires.
        }
      };

      if (signal) {
        signal.addEventListener('abort', closeStream, { once: true });
      }

      for (const message of messages) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      }
    },
  });
}

function makeFetchResponse(messages: unknown[], signal?: AbortSignal): Response {
  return new Response(makeStream(messages, signal), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
    },
  });
}

function makeDecodedEvents(contractId: string): DecodedContractEvent[] {
  return [
    {
      contractId,
      rawEventType: 'submitted',
      contractEventType: 'InvoiceSubmitted',
      topics: ['submitted', 1, 'GFREELANCER', 'GPAYER'],
      data: {
        invoice_id: 1,
        freelancer: 'GFREELANCER',
        payer: 'GPAYER',
        token: 'GTOKEN',
        amount: '1000',
        due_date: 200,
        discount_rate: 250,
        status: 'Pending',
        referral_code: null,
        timestamp: 100,
      },
    },
    {
      contractId,
      rawEventType: 'funded',
      contractEventType: 'InvoiceFunded',
      topics: ['funded', 2, 'GLP'],
      data: {
        invoice_id: 2,
        funder: 'GLP',
        freelancer: 'GFREELANCER',
        payer: 'GPAYER',
        token: 'GTOKEN',
        fund_amount: '250',
        amount_funded: '250',
        invoice_amount: '1000',
        due_date: 210,
        discount_rate: 250,
        funded_at: 110,
        status: 'Funded',
        lp: 'GLP',
        effective_yield_bps: 7,
        timestamp: 110,
      },
    },
    {
      contractId,
      rawEventType: 'paid',
      contractEventType: 'InvoicePaid',
      topics: ['paid', 3, 'GPAYER', 'GLP'],
      data: {
        invoice_id: 3,
        payer: 'GPAYER',
        lp: 'GLP',
        freelancer: 'GFREELANCER',
        token: 'GTOKEN',
        amount_paid: '1000',
        lp_earned: '100',
        lp_payout: '1100',
        settlement_timestamp: 120,
        paid_on_time: true,
        status: 'Paid',
      },
    },
    {
      contractId,
      rawEventType: 'cancelled',
      contractEventType: 'InvoiceCancelled',
      topics: ['cancelled', 4],
      data: {
        invoice_id: 4,
        freelancer: 'GFREELANCER',
        status: 'Cancelled',
      },
    },
    {
      contractId,
      rawEventType: 'expired',
      contractEventType: 'InvoiceExpired',
      topics: ['expired', 5],
      data: {
        invoice_id: 5,
        freelancer: 'GFREELANCER',
        status: 'Expired',
      },
    },
    {
      contractId,
      rawEventType: 'disputed',
      contractEventType: 'InvoiceDisputed',
      topics: ['disputed', 6, 'GPAYER'],
      data: {
        invoice_id: 6,
        payer: 'GPAYER',
        reason_hash: 'HASH',
        disputed_at: 130,
      },
    },
    {
      contractId,
      rawEventType: 'reputation_updated',
      contractEventType: 'ReputationUpdated',
      topics: ['reputation_updated', 'GREPUTATION'],
      data: {
        address: 'GREPUTATION',
        old_score: 10,
        new_score: 11,
        invoices_submitted: 1,
        invoices_paid: 2,
        invoices_defaulted: 3,
      },
    },
    {
      contractId,
      rawEventType: 'paused',
      contractEventType: 'ContractPaused',
      topics: ['paused'],
      data: {
        timestamp: 140,
      },
    },
  ];
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('event ingestion listener', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ingests core contract events and updates repository state', async () => {
    const repository = new MemoryRepository();
    const contractId = 'CDUMMYCONTRACT';
    const record: HorizonTransactionRecord = {
      hash: 'tx-1',
      ledger: 321,
      created_at: '2026-06-29T12:00:00Z',
      paging_token: '321',
      result_meta_xdr: 'ignored',
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      makeFetchResponse([record], init?.signal)
    );
    const decodeMock = vi.fn(() => makeDecodedEvents(contractId));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const listener = new EventListener({
      repository,
      horizonUrl: 'http://horizon.test',
      contractAddress: contractId,
      fetchImpl: fetchMock as unknown as typeof fetch,
      decodeTransactionEvents: decodeMock,
      logger,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
    });

    const startPromise = listener.start();
    await waitFor(() => repository.state.get('last_processed_cursor') === '321');
    listener.stop();
    await startPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeMock).toHaveBeenCalledTimes(1);
    expect(repository.events).toHaveLength(8);
    expect(repository.events.map((event) => event.event_type)).toEqual([
      'submitted',
      'funded',
      'paid',
      'cancelled',
      'expired',
      'disputed',
      'reputation_updated',
      'paused',
    ]);
    expect(repository.invoices.get(1)?.status).toBe('Pending');
    expect(repository.invoices.get(2)?.status).toBe('Funded');
    expect(repository.invoices.get(3)?.status).toBe('Paid');
    expect(repository.invoices.get(4)?.status).toBe('Cancelled');
    expect(repository.invoices.get(5)?.status).toBe('Expired');
    expect(repository.invoices.get(6)?.status).toBe('Disputed');
    expect(repository.reputationUpdates).toHaveLength(1);
    expect(repository.state.get('last_processed_ledger')).toBe('321');
    expect(logger.info).toHaveBeenCalled();
  });

  it('resumes from the last processed cursor after restart', async () => {
    const repository = new MemoryRepository();
    repository.setState('last_processed_cursor', '9000');
    const contractId = 'CDUMMYCONTRACT';
    const record: HorizonTransactionRecord = {
      hash: 'tx-2',
      ledger: 322,
      created_at: '2026-06-29T12:01:00Z',
      paging_token: '9001',
      result_meta_xdr: 'ignored',
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      makeFetchResponse([record], init?.signal)
    );
    const decodeMock = vi.fn(() => makeDecodedEvents(contractId).slice(0, 1));
    const listener = new EventListener({
      repository,
      horizonUrl: 'http://horizon.test',
      contractAddress: contractId,
      fetchImpl: fetchMock as unknown as typeof fetch,
      decodeTransactionEvents: decodeMock,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
    });

    const startPromise = listener.start();
    await waitFor(() => repository.state.get('last_processed_cursor') === '9001');
    listener.stop();
    await startPromise;

    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.searchParams.get('cursor')).toBe('9000');
  });

  it('reconnects with backoff after a transient stream failure', async () => {
    const repository = new MemoryRepository();
    const contractId = 'CDUMMYCONTRACT';
    const record: HorizonTransactionRecord = {
      hash: 'tx-3',
      ledger: 323,
      created_at: '2026-06-29T12:02:00Z',
      paging_token: '9002',
      result_meta_xdr: 'ignored',
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) =>
        makeFetchResponse([record], init?.signal)
      );
    const decodeMock = vi.fn(() => makeDecodedEvents(contractId).slice(0, 1));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const listener = new EventListener({
      repository,
      horizonUrl: 'http://horizon.test',
      contractAddress: contractId,
      fetchImpl: fetchMock as unknown as typeof fetch,
      decodeTransactionEvents: decodeMock,
      logger,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
    });

    const startPromise = listener.start();
    await waitFor(() => repository.state.get('last_processed_cursor') === '9002');
    listener.stop();
    await startPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});
