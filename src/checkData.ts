import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

function getSafeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
      .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_HEX_SECRET]")
      .slice(0, 240);
  }

  return "Unknown parse error";
}

function listJsonFiles(dir: string) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => path.join(dir, fileName));
}

const files = listJsonFiles(DATA_DIR);

if (files.length === 0) {
  console.log("No data/*.json files found.");
  process.exit(0);
}

let badCount = 0;

for (const filePath of files) {
  const label = path.relative(process.cwd(), filePath);

  try {
    const raw = fs.readFileSync(filePath, "utf8");

    if (raw.trim()) {
      JSON.parse(raw);
    }

    console.log(`OK  ${label}`);
  } catch (error) {
    badCount += 1;
    console.log(`BAD ${label} - ${getSafeErrorMessage(error)}`);
  }
}

if (badCount > 0) {
  console.log(`\n${badCount} JSON data file(s) failed validation.`);
  process.exit(1);
}

console.log(`\n${files.length} JSON data file(s) OK.`);
