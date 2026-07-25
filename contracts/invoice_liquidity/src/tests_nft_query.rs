#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};

    use crate::{InvoiceLiquidityContract, InvoiceNftMetadata};

    #[test]
    fn test_query_nft_metadata_not_found() {
        let env = Env::default();
        let contract = InvoiceLiquidityContract;

        // Query NFT metadata for non-existent invoice
        let result = contract.query_nft_metadata(env, 999);

        // Should return None
        assert_eq!(result, None);
    }

    #[test]
    fn test_query_nft_owner_not_found() {
        let env = Env::default();
        let contract = InvoiceLiquidityContract;

        // Query owner for non-existent invoice
        let result = contract.query_nft_owner(env, 999);

        // Should return None
        assert_eq!(result, None);
    }
}
