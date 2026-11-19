
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Output file
const OUTPUT_PATH = path.join(__dirname, "../docs/contract-abi.md")

interface Contract {
  title: string
  contractPath: string
  /** Falls back to contractPath when the enum isn't defined in its own file. */
  errorsPath?: string
  errorEnum: string
}

const CONTRACTS: Contract[] = [
  {
    title: "InvoiceLiquidityContract",
    contractPath: path.join(__dirname, "../contracts/invoice_liquidity/src/lib.rs"),
    errorsPath: path.join(__dirname, "../contracts/invoice_liquidity/src/errors.rs"),
    errorEnum: "ContractError",
  },
  {
    title: "InsurancePool",
    contractPath: path.join(__dirname, "../contracts/insurance_pool/src/lib.rs"),
    errorEnum: "InsuranceError",
  },
]

function extractFunctions(code: string) {
  // [^)]* (rather than .*?) and [^{]+? (rather than [^{\s]+) both match across
  // newlines, so multi-line signatures and multi-word return types (e.g.
  // "Result<(), ContractError>") are captured correctly.
  const functionRegex =
    /(?:\/\/\/\s*(.*?)\n)?\s*pub fn (\w+)\(([^)]*)\)\s*->\s*([^{]+?)\s*\{/g

  const functions: any[] = []

  let match
  while ((match = functionRegex.exec(code)) !== null) {
    const [, doc, name, params, returnType] = match

    functions.push({
      name,
      params: params.trim().replace(/\s+/g, " "),
      returnType: returnType.trim().replace(/\s+/g, " "),
      description: doc || "No description",
    })
  }

  return functions
}

function extractErrors(code: string, enumName: string) {
  const enumRegex = new RegExp(`enum ${enumName}\\s*{([\\s\\S]*?)\\n}`, "m")

  const match = code.match(enumRegex)
  if (!match) return []

  // Match each `Name = Code,` variant on its own line, skipping doc comments
  // (`///`) and plain comments so they don't get fused into the entry.
  const variantRegex = /^\s*(\w+)\s*=\s*(\d+)\s*,/gm
  const variants: string[] = []
  let variantMatch
  while ((variantMatch = variantRegex.exec(match[1])) !== null) {
    variants.push(`${variantMatch[1]} = ${variantMatch[2]}`)
  }

  return variants
}

function generateContractSection(title: string, functions: any[], errors: string[]) {
  let md = `## ${title}\n\n`

  md += `### Functions\n\n`
  md += `| Function | Parameters | Returns | Description |\n`
  md += `|----------|------------|---------|-------------|\n`

  for (const fn of functions) {
    md += `| ${fn.name} | ${fn.params} | ${fn.returnType} | ${fn.description} |\n`
  }

  md += `\n### Contract Errors\n\n`

  for (const err of errors) {
    md += `- ${err}\n`
  }

  return md
}

function main() {
  let markdown = `# Contract ABI Documentation\n\n`

  for (const contract of CONTRACTS) {
    const source = fs.readFileSync(contract.contractPath, "utf8")
    const errorsSource =
      contract.errorsPath && fs.existsSync(contract.errorsPath)
        ? fs.readFileSync(contract.errorsPath, "utf8")
        : source
    const functions = extractFunctions(source)
    const errors = extractErrors(errorsSource, contract.errorEnum)

    markdown += generateContractSection(contract.title, functions, errors)
    markdown += `\n---\n\n`
  }

  fs.writeFileSync(OUTPUT_PATH, markdown.trimEnd() + "\n")

  console.log(`✅ ABI generated at docs/contract-abi.md (${CONTRACTS.map((c) => c.title).join(", ")})`)
}

main()