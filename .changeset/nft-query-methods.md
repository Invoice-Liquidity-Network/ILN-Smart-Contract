---
"@iln/sdk": minor
---

Add SDK methods to query NFT metadata and ownership: getNftMetadata() and getNftOwner() (#423). These functions expose the contract's query_nft_metadata and query_nft_owner endpoints, enabling NFT marketplace features by allowing clients to fetch complete NFT metadata including invoice details, amount, owner, and mint timestamp.
