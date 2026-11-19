#[cfg(test)]
mod tests {
    use crate::invoice::{Invoice, InvoiceCore, InvoiceMetadata, InvoiceStatus, ReferralCode};
    use soroban_sdk::testutils::Address as TestAddress;
    use soroban_sdk::{Address, Env};

    #[test]
    fn test_invoice_to_core_split() {
        let env = Env::default();
        // Create a full invoice
        let invoice = Invoice {
            id: 123,
            freelancer: Address::generate(&env),
            payer: Address::generate(&env),
            token: Address::generate(&env),
            amount: 1_000_000,
            due_date: 1234567890,
            discount_rate: 300,
            status: InvoiceStatus::Pending,
            funder: Some(Address::generate(&env)),
            funded_at: Some(1234567800),
            amount_funded: 0,
            amount_paid: 0,
            referral_code: ReferralCode::None,
            submitter_reputation: 50,
        };

        // Extract core
        let core = invoice.to_core();
        assert_eq!(core.id, 123);
        assert_eq!(core.amount, 1_000_000);
        assert_eq!(core.due_date, 1234567890);
        assert_eq!(core.discount_rate, 300);
        assert_eq!(core.status, InvoiceStatus::Pending);
        assert_eq!(core.amount_funded, 0);
        assert_eq!(core.amount_paid, 0);

        // Extract metadata
        let metadata = invoice.to_metadata();
        assert_eq!(metadata.funded_at, Some(1234567800));
        assert_eq!(metadata.submitter_reputation, 50);
        assert_eq!(metadata.referral_code, ReferralCode::None);
    }

    #[test]
    fn test_invoice_core_with_metadata_roundtrip() {
        let env = Env::default();
        // Create core and metadata
        let freelancer = Address::generate(&env);
        let payer = Address::generate(&env);
        let token = Address::generate(&env);
        let funder = Address::generate(&env);

        let core = InvoiceCore {
            id: 456,
            freelancer: freelancer.clone(),
            payer: payer.clone(),
            token: token.clone(),
            amount: 2_000_000,
            due_date: 1234567890,
            discount_rate: 500,
            status: InvoiceStatus::Funded,
            amount_funded: 2_000_000,
            amount_paid: 0,
        };

        let metadata = InvoiceMetadata {
            funder: Some(funder.clone()),
            funded_at: Some(1234567850),
            referral_code: ReferralCode::None,
            submitter_reputation: 75,
        };

        // Combine into full invoice
        let invoice = core.clone().with_metadata(metadata.clone());

        // Verify all fields match
        assert_eq!(invoice.id, 456);
        assert_eq!(invoice.freelancer, freelancer);
        assert_eq!(invoice.payer, payer);
        assert_eq!(invoice.token, token);
        assert_eq!(invoice.amount, 2_000_000);
        assert_eq!(invoice.due_date, 1234567890);
        assert_eq!(invoice.discount_rate, 500);
        assert_eq!(invoice.status, InvoiceStatus::Funded);
        assert_eq!(invoice.amount_funded, 2_000_000);
        assert_eq!(invoice.amount_paid, 0);
        assert_eq!(invoice.funder, Some(funder));
        assert_eq!(invoice.funded_at, Some(1234567850));
        assert_eq!(invoice.submitter_reputation, 75);

        // Round-trip back to core and metadata
        assert_eq!(invoice.to_core(), core);
        assert_eq!(invoice.to_metadata(), metadata);
    }

    #[test]
    fn test_invoice_hot_cold_separation_consistency() {
        let env = Env::default();
        // Test that extracting hot/cold and recombining gives same result
        let invoice = Invoice {
            id: 789,
            freelancer: Address::generate(&env),
            payer: Address::generate(&env),
            token: Address::generate(&env),
            amount: 5_000_000,
            due_date: 987654321,
            discount_rate: 100,
            status: InvoiceStatus::PartiallyFunded,
            funder: None,
            funded_at: None,
            amount_funded: 2_500_000,
            amount_paid: 1_500_000,
            referral_code: ReferralCode::None,
            submitter_reputation: 25,
        };

        let core = invoice.to_core();
        let metadata = invoice.to_metadata();
        let reconstructed = core.with_metadata(metadata);

        // Should be identical
        assert_eq!(invoice.id, reconstructed.id);
        assert_eq!(invoice.amount, reconstructed.amount);
        assert_eq!(invoice.amount_funded, reconstructed.amount_funded);
        assert_eq!(invoice.amount_paid, reconstructed.amount_paid);
        assert_eq!(invoice.status, reconstructed.status);
        assert_eq!(invoice.funder, reconstructed.funder);
        assert_eq!(invoice.funded_at, reconstructed.funded_at);
        assert_eq!(
            invoice.submitter_reputation,
            reconstructed.submitter_reputation
        );
    }
}
