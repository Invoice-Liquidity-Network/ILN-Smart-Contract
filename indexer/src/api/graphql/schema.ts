export const typeDefs = /* GraphQL */ `
  # -------------------------------------------------------------------------
  # Scalars
  # -------------------------------------------------------------------------

  """Unix timestamp in seconds."""
  scalar Timestamp

  # -------------------------------------------------------------------------
  # Invoice
  # -------------------------------------------------------------------------

  """Filter options for the invoices query."""
  input InvoiceFilter {
    status: String
    token: String
    submitter: String
  }

  """Pagination arguments."""
  input Pagination {
    page: Int
    pageSize: Int
  }

  """A single invoice indexed from on-chain events."""
  type Invoice {
    id: Int!
    freelancer: String!
    payer: String!
    token: String!
    amount: String!
    dueDate: Timestamp!
    discountRate: Int!
    status: String!
    funder: String
    fundedAt: Timestamp
    amountFunded: String!
    amountPaid: String!
    referralCode: String
    submitterReputation: Int!
    createdAt: Timestamp!
    effectiveYieldBps: Int!
    remainingBalance: String!
    daysUntilExpiry: Int!
  }

  """Paginated list of invoices."""
  type InvoiceConnection {
    invoices: [Invoice!]!
    total: Int!
    page: Int!
    pageSize: Int!
  }

  # -------------------------------------------------------------------------
  # Reputation
  # -------------------------------------------------------------------------

  """A historical score entry in the reputation timeline."""
  type ReputationHistoryEntry {
    ledger: Int!
    score: Int!
    eventType: String!
    timestamp: Timestamp!
  }

  """Reputation profile for a Stellar address."""
  type ReputationScore {
    address: String!
    score: Int!
    invoicesPaid: Int!
    invoicesDefaulted: Int!
    invoicesSubmitted: Int!
    lastActivityLedger: Int!
    history: [ReputationHistoryEntry!]!
  }

  # -------------------------------------------------------------------------
  # Leaderboard
  # -------------------------------------------------------------------------

  """A single entry in the reputation leaderboard."""
  type LeaderboardEntry {
    rank: Int!
    address: String!
    score: Int!
    invoicesPaid: Int!
    invoicesDefaulted: Int!
    totalVolume: String!
  }

  # -------------------------------------------------------------------------
  # Governance
  # -------------------------------------------------------------------------

  """A governance proposal (on-chain — not persisted in the indexer DB)."""
  type GovernanceProposal {
    id: String!
    action: String!
    proposedValue: String!
    descriptionHash: String!
    proposer: String!
    votesFor: String!
    votesAgainst: String!
    status: String!
    votingEndsAt: Timestamp!
  }

  # -------------------------------------------------------------------------
  # Contract stats
  # -------------------------------------------------------------------------

  """Protocol-level aggregate statistics."""
  type ContractStats {
    totalInvoices: Int!
    totalFunded: Int!
    totalPaid: Int!
    totalCancelled: Int!
    totalExpired: Int!
    totalDisputed: Int!
    avgDiscountRateBps: Float!
    disputeRate: Float!
    lastUpdatedAt: Timestamp!
  }

  # -------------------------------------------------------------------------
  # Root query
  # -------------------------------------------------------------------------

  type Query {
    """Fetch a single invoice by its numeric ID."""
    invoice(id: Int!): Invoice

    """List invoices with optional filtering and pagination."""
    invoices(filter: InvoiceFilter, pagination: Pagination): InvoiceConnection!

    """Fetch the reputation profile for a Stellar address."""
    reputation(address: String!): ReputationScore!

    """
    Top addresses ranked by reputation score.
    Returns at most 100 entries (default 50).
    """
    leaderboard(limit: Int): [LeaderboardEntry!]!

    """Protocol-level aggregate statistics."""
    stats: ContractStats!

    """
    Governance proposals are stored on-chain, not in the indexer DB.
    This stub always returns an empty list — use the SDK governance
    methods to query proposals directly from the contract.
    """
    governanceProposals: [GovernanceProposal!]!
  }
`;
