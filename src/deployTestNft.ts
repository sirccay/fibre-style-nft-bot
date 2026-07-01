import "dotenv/config";
import fs from "fs";
import path from "path";
import solc from "solc";
import { ethers } from "ethers";
import { getWalletByLabel } from "./vault.js";

const CONTRACT_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestMintNFT {
    string public name = "Test Mint NFT";
    string public symbol = "TMNFT";

    uint256 public constant PRICE = 0.01 ether;
    uint256 public constant MAX_SUPPLY = 1000;
    uint256 public totalSupply;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) public view returns (uint256) {
        require(owner != address(0), "Zero address");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "Token does not exist");
        return owner;
    }

    function publicMint(uint256 quantity) public payable {
        require(quantity > 0, "Quantity must be more than zero");
        require(quantity <= 5, "Max 5 per tx");
        require(totalSupply + quantity <= MAX_SUPPLY, "Sold out");
        require(msg.value == PRICE * quantity, "Wrong ETH amount");

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = totalSupply + 1;
            totalSupply++;

            _owners[tokenId] = msg.sender;
            _balances[msg.sender]++;

            emit Transfer(address(0), msg.sender, tokenId);
        }
    }

    function approve(address spender, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "Not approved");

        getApproved[tokenId] = spender;
        emit Approval(owner, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) public {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(owner == from, "Wrong owner");
        require(to != address(0), "Zero address");
        require(
            msg.sender == owner ||
            getApproved[tokenId] == msg.sender ||
            isApprovedForAll[owner][msg.sender],
            "Not approved"
        );

        getApproved[tokenId] = address(0);
        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }
}
`;

function compileContract() {
  const input = {
    language: "Solidity",
    sources: {
      "TestMintNFT.sol": {
        content: CONTRACT_SOURCE
      }
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode"]
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    for (const error of output.errors) {
      console.log(error.formattedMessage);
    }

    const hasRealError = output.errors.some((error: any) => error.severity === "error");
    if (hasRealError) {
      throw new Error("Solidity compilation failed.");
    }
  }

  const contract = output.contracts["TestMintNFT.sol"]["TestMintNFT"];

  return {
    abi: contract.abi,
    bytecode: contract.evm.bytecode.object
  };
}

async function main() {
  const walletLabel = process.argv[2] || "wallet1";

  const rpcUrl = process.env.RPC_URL_SEPOLIA;
  const provider = rpcUrl
    ? new ethers.JsonRpcProvider(rpcUrl)
    : ethers.getDefaultProvider("sepolia");

  const wallet = getWalletByLabel(walletLabel, provider);

  console.log("\n🚀 Deploying TestMintNFT to Sepolia...");
  console.log(`Using wallet: ${walletLabel}`);
  console.log(`Address: ${wallet.address}`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  const compiled = compileContract();

  const factory = new ethers.ContractFactory(
    compiled.abi,
    compiled.bytecode,
    wallet
  );

  const contract = await factory.deploy();

  console.log("⏳ Deployment transaction sent...");
  console.log(`Tx: ${contract.deploymentTransaction()?.hash}`);

  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();

  console.log("\n✅ Test NFT contract deployed.");
  console.log(`Contract: ${contractAddress}`);

  const dataDir = path.join(process.cwd(), "data");

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(dataDir, "testNft.json"),
    JSON.stringify(
      {
        network: "sepolia",
        contractAddress,
        abi: compiled.abi,
        deployedAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  console.log("\nSaved contract details to data/testNft.json");
}

main().catch((error) => {
  console.error("\n❌ Deployment failed:");
  console.error(error);
  process.exit(1);
});
