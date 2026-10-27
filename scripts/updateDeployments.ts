// pnpm run update:deployments

import { Address } from 'viem';
import { writeFileSync, readFileSync } from 'node:fs';
import { ChainId, PERMIT2 } from '../src/utils/constants';
import { balancerV2Contracts as existingV2Contracts } from '../src/utils/balancerV2Contracts';
import { balancerV3Contracts as existingV3Contracts } from '../src/utils/balancerV3Contracts';
import {
    ContractRegistry,
    SupportedNetwork,
    SupportedNetworkResponse,
    AbiResponse,
    NetworkRegistryResponse,
} from './scripts.types';

// Create a map that looks like ['1': '[ChainId.MAINNET]', '10': '[ChainId.OPTIMISM]', ...]
const chainIdToHumanKey = Object.fromEntries(
    Object.entries(ChainId)
        .filter(([key]) => Number.isNaN(Number(key))) // Filter out numeric keys (enum values)
        .map(([key, value]) => [value, `[ChainId.${key}]`]),
);

const targetContractsV2 = [
    'Vault',
    'BalancerRelayer',
    'BalancerQueries',
    'WeightedPoolFactory',
    'Authorizer',
];

// Update this list to add new contracts
const targetContractsV3 = [
    'Vault',
    'VaultAdmin',
    'VaultExtension',
    'Router',
    'BatchRouter',
    'CompositeLiquidityRouter',
    'BufferRouter',
    'WeightedPoolFactory',
    'StablePoolFactory',
    'StableSurgePoolFactory',
    'GyroECLPPoolFactory',
    'LBPoolFactory',
    'FixedPriceLBPoolFactory',
    'ReClammPoolFactory',
    'MockGyroEclpPool',
    'MevCaptureHook',
    'StableSurgeHook',
    'UnbalancedAddViaSwapRouter',
];

const targetContracts = [...targetContractsV2, ...targetContractsV3];

const balancerV2Contracts: ContractRegistry = {};
const balancerV3Contracts: ContractRegistry = {};
const permit2Updates: Record<string, Address> = {};

const deploymentsOrg = 'frontier-fi';
const deploymentsRepo = 'deployments';
const branch = 'main'; // point this at any frontier-fi/deployments branch
const deploymentsBase = `https://raw.githubusercontent.com/${deploymentsOrg}/${deploymentsRepo}/refs/heads/${branch}`;

async function updateBalancerDeployments() {
    seedFromExisting(
        existingV2Contracts as unknown as Record<
            string,
            Record<number | string, string>
        >,
        balancerV2Contracts,
    );
    seedFromExisting(
        existingV3Contracts as unknown as Record<
            string,
            Record<number | string, string>
        >,
        balancerV3Contracts,
    );
    const supportedNetworks = await fetchSupportedNetworks();
    await processContractData(supportedNetworks);
    updateContractAddresses();
    exportAbis();
}

/**
 * Seed registries from current SDK files so networks Frontier has not
 * published yet are preserved when we rewrite the address files.
 */
function seedFromExisting(
    existing: Record<string, Record<number | string, string>>,
    target: ContractRegistry,
) {
    for (const [name, addresses] of Object.entries(existing)) {
        target[name] = {};
        for (const [chainId, address] of Object.entries(addresses)) {
            const key = chainIdToHumanKey[Number(chainId)];
            if (key && address) {
                target[name][key] = address as Address;
            }
        }
    }
}

async function fetchSupportedNetworks(): Promise<SupportedNetwork[]> {
    const res = await fetch(
        `${deploymentsBase}/addresses/.supported-networks.json`,
    );
    if (!res.ok) {
        throw new Error(
            `Failed to fetch supported networks: ${res.status} ${res.statusText}`,
        );
    }
    const data: Record<string, SupportedNetworkResponse> = await res.json();

    const supportedNetworks = Object.entries(data).map(
        ([name, { chainId }]) => ({
            networkName: name,
            chainId,
            deploymentsUrl: `${deploymentsBase}/addresses/${name}.json`,
        }),
    );

    supportedNetworks.sort((a, b) =>
        a.networkName.localeCompare(b.networkName),
    );

    return supportedNetworks;
}

async function processContractData(supportedNetworks: SupportedNetwork[]) {
    // Process each network sequentially to maintain consistent order
    for (const { networkName, chainId, deploymentsUrl } of supportedNetworks) {
        const res = await fetch(deploymentsUrl);
        if (!res.ok) {
            throw new Error(`Failed to fetch network data for ${networkName}`);
        }

        const data: NetworkRegistryResponse = await res.json();

        // Process each task sequentially to maintain consistent order
        for (const [taskId, value] of Object.entries(data)) {
            if (value.status !== 'ACTIVE') continue;
            // Frontier address files omit version; deployments are V3.
            const version = value.version ?? 'v3';

            for (const contract of value.contracts) {
                if (!targetContracts.includes(contract.name)) continue;

                const { name } = contract;

                if (version === 'v2' && targetContractsV2.includes(name)) {
                    if (!balancerV2Contracts[name])
                        balancerV2Contracts[name] = {};
                    balancerV2Contracts[name][chainIdToHumanKey[chainId]] =
                        contract.address;
                }
                if (version === 'v3' && targetContractsV3.includes(name)) {
                    if (!balancerV3Contracts[name])
                        balancerV3Contracts[name] = {};
                    balancerV3Contracts[name][chainIdToHumanKey[chainId]] =
                        contract.address;
                }

                // Grab contract ABIs using only sepolia
                if (networkName === 'sepolia' && version === 'v3') {
                    // frontier-fi/deployments keeps artifacts under tasks/ (no v3/ prefix)
                    const url = `${deploymentsBase}/tasks/${taskId}/artifact/${contract.name}.json`;
                    const abiRes = await fetch(url);
                    if (!abiRes.ok) {
                        console.warn(
                            `Skipping ABI for ${contract.name}: ${abiRes.status} ${abiRes.statusText}`,
                        );
                        continue;
                    }
                    const abiData: AbiResponse = await abiRes.json();

                    const contractName =
                        contract.name.charAt(0).toLowerCase() +
                        contract.name.slice(1);
                    const content = `export const ${contractName}Abi_${version.toUpperCase()} = ${JSON.stringify(
                        abiData.abi,
                        undefined,
                        4,
                    )} as const;`;
                    const path = `./src/abi/${version}/${contractName}.ts`;
                    writeFileSync(path, content);
                }
            }
        }

        // Update Permit2 entries when the deployments repo publishes them
        // https://github.com/frontier-fi/deployments/tree/main/tasks
        try {
            const permit2Url = `${deploymentsBase}/tasks/00000000-permit2/output/${networkName}.json`;
            const permit2Result = await fetch(permit2Url);
            if (!permit2Result.ok) {
                throw new Error(
                    `HTTP ${permit2Result.status} ${permit2Result.statusText}`,
                );
            }
            const permit2Data = await permit2Result.json();
            const permit2Address = permit2Data.Permit2;
            if (!permit2Address) {
                throw new Error(
                    `Failed to fetch Permit2 data for ${networkName}`,
                );
            }

            if (!PERMIT2[chainId]) {
                const chainIdKey = chainIdToHumanKey[chainId];
                if (chainIdKey) {
                    permit2Updates[chainIdKey] = permit2Address;
                } else {
                    console.warn(
                        `No ChainId enum found for chainId ${chainId}`,
                    );
                }
            }
        } catch (e) {
            // Frontier has not published a Permit2 task yet; Sepolia already
            // uses the canonical Permit2 address in constants.ts
            console.log(`Failed to fetch Permit2 for ${networkName}: ${e}`);
        }
    }
}

function updateContractAddresses() {
    // Sort the contracts by name for easier PR reviews
    const sortedV2Contracts = Object.fromEntries(
        Object.entries(balancerV2Contracts).sort(([a], [b]) =>
            a.localeCompare(b),
        ),
    );
    const sortedV3Contracts = Object.fromEntries(
        Object.entries(balancerV3Contracts).sort(([a], [b]) =>
            a.localeCompare(b),
        ),
    );

    // Import ChainId to make the keys human readable
    const chainIdImport = `import {ChainId} from "@/utils/constants";\n\n`;

    // Write the contract addresses to the utils files
    const balancerV2Content =
        `${chainIdImport} export const balancerV2Contracts = ${JSON.stringify(
            sortedV2Contracts,
            undefined,
            4,
        )} as const;`.replace(/"(\[ChainId\.[A-Z_]+\])"/g, '$1');
    writeFileSync('./src/utils/balancerV2Contracts.ts', balancerV2Content);

    const balancerV3Content =
        `${chainIdImport} export const balancerV3Contracts = ${JSON.stringify(
            sortedV3Contracts,
            undefined,
            4,
        )} as const;`.replace(/"(\[ChainId\.[A-Z_]+\])"/g, '$1');
    writeFileSync('./src/utils/balancerV3Contracts.ts', balancerV3Content);

    // Update PERMIT2 addresses if there are new entries
    if (Object.keys(permit2Updates).length > 0) {
        // Read the current constants file
        const constantsPath = './src/utils/constants.ts';
        const constantsContent = readFileSync(constantsPath, 'utf-8');

        // Find the existing PERMIT2 object
        const permit2Regex =
            /(export const PERMIT2: Record<number, Address> = \{)([\s\S]*?)(\};)/;
        const permit2Match = constantsContent.match(permit2Regex);

        if (!permit2Match) {
            throw new Error('Could not find PERMIT2 object in constants file');
        }

        // Parse existing entries
        const existingContent = permit2Match[2];
        const existingPermit2: Record<string, Address> = {};

        // Extract existing entries
        const entryRegex = /(\[ChainId\.[A-Z_]+\]):\s*'([^']+)'/g;
        for (const match of existingContent.matchAll(entryRegex)) {
            existingPermit2[match[1]] = match[2] as Address;
        }

        // Merge with updates (existing entries take precedence to avoid overwriting)
        const mergedPermit2 = { ...existingPermit2, ...permit2Updates };

        // Sort by key for consistent ordering
        const sortedPermit2 = Object.fromEntries(
            Object.entries(mergedPermit2).sort(([a], [b]) =>
                a.localeCompare(b),
            ),
        );

        // Generate the updated PERMIT2 content
        const permit2Entries = Object.entries(sortedPermit2)
            .map(([key, value]) => `    ${key}: '${value}',`)
            .join('\n');

        // Replace the PERMIT2 object in the constants file
        const updatedConstants = constantsContent.replace(
            permit2Regex,
            `$1\n${permit2Entries}\n$3`,
        );

        writeFileSync(constantsPath, updatedConstants);
    }
}

function exportAbis() {
    const exportAbisV2 = targetContractsV2.map(
        (contract) =>
            `export * from './${
                contract[0].toLowerCase() + contract.slice(1)
            }';`,
    );

    const staticHelperAbisV3 = [
        'weightedPool',
        'stablePool',
        'liquidityBootstrappingPool',
        'gyro2CLP',
        'gyroECLP',
    ];

    const exportAbisV3 = [...staticHelperAbisV3, ...targetContractsV3].map(
        (contract) =>
            `export * from './${
                contract[0].toLowerCase() + contract.slice(1)
            }';`,
    );
    writeFileSync('./src/abi/v2/index.ts', exportAbisV2.join('\n'));
    writeFileSync('./src/abi/v3/index.ts', exportAbisV3.join('\n'));
}

updateBalancerDeployments();
