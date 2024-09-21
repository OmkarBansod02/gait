import * as fs from 'fs';
import * as path from 'path';

import simpleGit, { SimpleGit } from 'simple-git';
import { StashedState, PanelChat, isStashedState } from './types';

const SCHEMA_VERSION = '1.0';

export type CommitData = {
    commitHash: string;
    date: Date;
    commitMessage: string;
    author: string;
    panelChats: PanelChat[]; // Updated from messages to panelChats
};

export type UncommittedData = {
    panelChats: PanelChat[]; // Updated from messages to panelChats
};

export type GitHistoryData = {
    commits: CommitData[];
    uncommitted: UncommittedData | null;
};

enum LogLevel {
    INFO,
    WARN,
    ERROR
}

const CURRENT_LOG_LEVEL = LogLevel.INFO;

/**
 * Logs messages based on the specified log level.
 * @param message - The message to log.
 * @param level - The severity level of the log.
 */
function log(message: string, level: LogLevel = LogLevel.INFO) {
    if (level >= CURRENT_LOG_LEVEL) {
        switch (level) {
            case LogLevel.INFO:
                console.log(message);
                break;
            case LogLevel.WARN:
                console.warn(message);
                break;
            case LogLevel.ERROR:
                console.error(message);
                break;
        }
    }
}

/**
 * Ensures that the 'deletedChats' object and its nested properties exist.
 * @param stashedState - The StashedState object to validate and initialize.
 * @param commitHash - The hash of the current commit (for logging purposes).
 */
function ensureDeletedChats(stashedState: StashedState, commitHash: string) {
    if (!stashedState.deletedChats) {
        stashedState.deletedChats = { deletedMessageIDs: [], deletedPanelChatIDs: [] };
        log(`'deletedChats' was undefined in commit ${commitHash}. Initialized with empty arrays.`, LogLevel.WARN);
    }

    if (!Array.isArray(stashedState.deletedChats.deletedPanelChatIDs)) {
        stashedState.deletedChats.deletedPanelChatIDs = [];
        log(`'deletedPanelChatIDs' was undefined or not an array in commit ${commitHash}. Initialized as empty array.`, LogLevel.WARN);
    }

    if (!Array.isArray(stashedState.deletedChats.deletedMessageIDs)) {
        stashedState.deletedChats.deletedMessageIDs = [];
        log(`'deletedMessageIDs' was undefined or not an array in commit ${commitHash}. Initialized as empty array.`, LogLevel.WARN);
    }
}

/**
 * Processes a single commit's stashedPanelChats.json and extracts active PanelChats and Messages.
 * @param parsedContent - The parsed StashedState from the commit.
 * @param currentMessageIds - Set of active message IDs.
 * @param currentPanelChatIds - Set of active PanelChat IDs.
 * @param seenMessageIds - Set to track already processed message IDs.
 * @param commitData - The CommitData object to populate.
 * @param commitHash - The hash of the current commit (for logging purposes).
 */
function processCommit(
    parsedContent: StashedState,
    currentMessageIds: Set<string>,
    currentPanelChatIds: Set<string>,
    seenMessageIds: Set<string>,
    commitData: CommitData,
    commitHash: string
) {
    ensureDeletedChats(parsedContent, commitHash);

    const deletedPanelChatIds = new Set(parsedContent.deletedChats.deletedPanelChatIDs);
    const deletedMessageIds = new Set(parsedContent.deletedChats.deletedMessageIDs);

    for (const panelChat of parsedContent.panelChats) {
        const panelChatId = panelChat.id;

        // Skip deleted PanelChats
        if (deletedPanelChatIds.has(panelChatId)) {
            log(`PanelChat ID ${panelChatId} has been deleted in commit ${commitHash}. Excluding from processing.`, LogLevel.INFO);
            continue;
        }

        // Create or retrieve existing PanelChat in commitData
        let existingPanelChat = commitData.panelChats.find(pc => pc.id === panelChatId);
        if (!existingPanelChat) {
            existingPanelChat = {
                ai_editor: panelChat.ai_editor,
                id: panelChat.id,
                customTitle: panelChat.customTitle,
                parent_id: panelChat.parent_id,
                created_on: panelChat.created_on,
                messages: []
            };
            commitData.panelChats.push(existingPanelChat);
            log(`Initialized PanelChat ID ${panelChatId} in commit ${commitHash}.`, LogLevel.INFO);
        }

        for (const messageEntry of panelChat.messages) {
            const messageId = messageEntry.id;

            // Only include active and unseen messages
            if (currentMessageIds.has(messageId) && !seenMessageIds.has(messageId)) {
                existingPanelChat.messages.push(messageEntry);
                log(`Added Message ID ${messageId} from PanelChat ${panelChatId} in commit ${commitHash}.`, LogLevel.INFO);
                seenMessageIds.add(messageId);
            } else {
                if (!currentMessageIds.has(messageId)) {
                    log(`Message ID ${messageId} has been deleted in the current state. Excluding from commit ${commitHash}.`, LogLevel.INFO);
                } else {
                    log(`Message ID ${messageId} has already been processed. Skipping.`, LogLevel.INFO);
                }
            }
        }
    }
}

/**
 * Retrieves the Git history for a specific file, capturing PanelChats instead of flat messages.
 * @param repoPath - The path to the Git repository.
 * @param filePath - The relative path to the target file within the repository.
 * @returns A Promise resolving to GitHistoryData containing commit history and uncommitted changes.
 */
export async function getGitHistory(repoPath: string, filePath: string): Promise<GitHistoryData> {
    const git: SimpleGit = simpleGit(repoPath);

    log("Starting getGitHistory", LogLevel.INFO);

    // Ensure the file exists in the repository
    const absoluteFilePath = path.resolve(repoPath, filePath);
    if (!fs.existsSync(absoluteFilePath)) {
        throw new Error(`File not found: ${absoluteFilePath}`);
    }

    // Step 1: Read the current stashedPanelChats.json to collect existing message and panelChat IDs
    let currentContent: string;
    let parsedCurrent: StashedState;
    const currentMessageIds: Set<string> = new Set();
    const currentPanelChatIds: Set<string> = new Set();

    try {
        currentContent = fs.readFileSync(absoluteFilePath, 'utf-8');
        log(`Successfully read ${absoluteFilePath}`, LogLevel.INFO);
    } catch (error) {
        log(`Warning: Failed to read current file content: ${(error as Error).message}`, LogLevel.WARN);
        // If reading fails, initialize with default structure
        currentContent = JSON.stringify({
            panelChats: [],
            schemaVersion: SCHEMA_VERSION,
            deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
        }, null, 2);
        log(`Initialized default stashedPanelChats.json structure.`, LogLevel.INFO);
    }

    try {
        parsedCurrent = JSON.parse(currentContent);
        if (!isStashedState(parsedCurrent)) {
            throw new Error('Parsed content does not match StashedState structure.');
        }
        log(`Parsed current stashedPanelChats.json successfully.`, LogLevel.INFO);
    } catch (error) {
        log(`Warning: Failed to parse current JSON content: ${(error as Error).message}`, LogLevel.WARN);
        // Initialize with default structure if parsing fails
        parsedCurrent = {
            panelChats: [],
            schemaVersion: SCHEMA_VERSION,
            deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
        };
        log(`Initialized default stashedPanelChats.json structure due to parsing failure.`, LogLevel.INFO);
    }

    // Ensure deletedChats exists
    if (!parsedCurrent.deletedChats) {
        parsedCurrent.deletedChats = { deletedMessageIDs: [], deletedPanelChatIDs: [] };
        log(`'deletedChats' was undefined. Initialized with empty arrays.`, LogLevel.WARN);
    }

    // Ensure deletedPanelChatIDs exists and is an array
    if (!Array.isArray(parsedCurrent.deletedChats.deletedPanelChatIDs)) {
        parsedCurrent.deletedChats.deletedPanelChatIDs = [];
        log(`'deletedPanelChatIDs' was undefined or not an array. Initialized as empty array.`, LogLevel.WARN);
    }

    // Ensure deletedMessageIDs exists and is an array
    if (!Array.isArray(parsedCurrent.deletedChats.deletedMessageIDs)) {
        parsedCurrent.deletedChats.deletedMessageIDs = [];
        log(`'deletedMessageIDs' was undefined or not an array. Initialized as empty array.`, LogLevel.WARN);
    }

    const deletedPanelChatIds = new Set(parsedCurrent.deletedChats.deletedPanelChatIDs);
    const deletedMessageIds = new Set(parsedCurrent.deletedChats.deletedMessageIDs);

    // Collect all current message and panelChat IDs excluding deleted ones
    for (const panelChat of parsedCurrent.panelChats) {
        if (!deletedPanelChatIds.has(panelChat.id)) {
            currentPanelChatIds.add(panelChat.id);
            for (const message of panelChat.messages) {
                if (!deletedMessageIds.has(message.id)) {
                    currentMessageIds.add(message.id);
                }
            }
        }
    }

    log(`Collected ${currentPanelChatIds.size} active PanelChat IDs and ${currentMessageIds.size} active Message IDs.`, LogLevel.INFO);

    // Step 2: Get the commit history for the file with --follow to track renames
    // '--reverse' ensures commits are ordered from oldest to newest
    const logArgs = ['log', '--reverse', '--follow', '--pretty=format:%H%x09%an%x09%ad%x09%s', '--', filePath];

    let logData: string;
    try {
        logData = await git.raw(logArgs);
        log(`Retrieved git log data successfully.`, LogLevel.INFO);
    } catch (error) {
        throw new Error(`Failed to retrieve git log: ${(error as Error).message}`);
    }

    const logLines = logData.split('\n').filter(line => line.trim() !== '');
    log(`Processing ${logLines.length} commits from git log.`, LogLevel.INFO);

    const allCommitsMap: Map<string, CommitData> = new Map();
    const seenMessageIds: Set<string> = new Set();

    for (const line of logLines) {
        const [commitHash, authorName, dateStr, ...commitMsgParts] = line.split('\t');
        const commitMessage = commitMsgParts.join('\t');

        // Skip commits that are solely for deletions
        if (commitMessage.startsWith('Delete message with ID') || commitMessage.startsWith('Delete PanelChat with ID')) {
            log(`Skipping deletion commit ${commitHash}: ${commitMessage}`, LogLevel.INFO);
            continue;
        }

        // Get the file content at this commit
        let fileContent: string;
        try {
            fileContent = await git.raw(['show', `${commitHash}:${filePath}`]);
            log(`Retrieved file content for commit ${commitHash}.`, LogLevel.INFO);
        } catch (error) {
            log(`Warning: Could not retrieve file at commit ${commitHash}. It might have been deleted or renamed.`, LogLevel.WARN);
            continue; // Skip this commit
        }

        // Parse the JSON content as StashedState
        let parsedContent: StashedState;
        try {
            parsedContent = JSON.parse(fileContent);
            if (!isStashedState(parsedContent)) {
                throw new Error('Parsed content does not match StashedState structure.');
            }
            log(`Parsed stashedPanelChats.json for commit ${commitHash} successfully.`, LogLevel.INFO);
        } catch (error) {
            log(`Warning: Failed to parse JSON for commit ${commitHash}: ${(error as Error).message}`, LogLevel.WARN);
            log(`Content: ${fileContent}`, LogLevel.WARN);
            continue; // Skip this commit
        }

        // Initialize or retrieve existing CommitData for this commit
        let commitData = allCommitsMap.get(commitHash);
        if (!commitData) {
            commitData = {
                commitHash,
                date: new Date(dateStr),
                commitMessage,
                author: authorName,
                panelChats: [], // Initialize panelChats
            };
            allCommitsMap.set(commitHash, commitData);
            log(`Initialized CommitData for commit ${commitHash}.`, LogLevel.INFO);
        }

        // Process the commit's panelChats
        processCommit(parsedContent, currentMessageIds, currentPanelChatIds, seenMessageIds, commitData, commitHash);
    }

    // Convert the map to an array
    let allCommits: CommitData[] = Array.from(allCommitsMap.values());

    // **New Addition:** Filter out commits with empty panelChats
    allCommits = allCommits.filter(commit => commit.panelChats.some(pc => pc.messages.length > 0));
    log(`Filtered commits to exclude empty ones. Remaining commits count: ${allCommits.length}`, LogLevel.INFO);

    // Step 3: Check for uncommitted changes
    let status;
    try {
        status = await git.status();
        log(`Retrieved git status successfully.`, LogLevel.INFO);
    } catch (error) {
        throw new Error(`Failed to retrieve git status: ${(error as Error).message}`);
    }

    let uncommitted: UncommittedData | null = null;
    log("Checking uncommitted changes", LogLevel.INFO);
    if (
        status.modified.includes(filePath) ||
        status.not_added.includes(filePath) ||
        status.created.includes(filePath)
    ) {
        // Get the current (uncommitted) file content
        log("stashedPanelChats.json is modified", LogLevel.INFO);
        let currentUncommittedContent: string;
        try {
            currentUncommittedContent = fs.readFileSync(absoluteFilePath, 'utf-8');
            log(`Successfully read uncommitted stashedPanelChats.json.`, LogLevel.INFO);
        } catch (error) {
            log(`Warning: Failed to read current file content: ${(error as Error).message}`, LogLevel.WARN);
            currentUncommittedContent = JSON.stringify({
                panelChats: [],
                schemaVersion: SCHEMA_VERSION,
                deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
            }, null, 2); // Default to empty StashedState
            log(`Initialized default uncommitted stashedPanelChats.json structure.`, LogLevel.INFO);
        }

        // Parse the JSON content as StashedState
        let parsedUncommitted: StashedState;
        try {
            parsedUncommitted = JSON.parse(currentUncommittedContent);
            if (!isStashedState(parsedUncommitted)) {
                throw new Error('Parsed content does not match StashedState structure.');
            }
            log(`Parsed uncommitted stashedPanelChats.json successfully.`, LogLevel.INFO);
        } catch (error) {
            log(`Warning: Failed to parse current JSON content: ${(error as Error).message}`, LogLevel.WARN);
            parsedUncommitted = {
                panelChats: [],
                schemaVersion: SCHEMA_VERSION,
                deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
            }; // Default to empty StashedState
            log(`Initialized default uncommitted stashedPanelChats.json structure due to parsing failure.`, LogLevel.INFO);
        }

        // Ensure deletedChats exists
        if (!parsedUncommitted.deletedChats) {
            parsedUncommitted.deletedChats = { deletedMessageIDs: [], deletedPanelChatIDs: [] };
            log(`'deletedChats' was undefined in uncommitted changes. Initialized with empty arrays.`, LogLevel.WARN);
        }

        // Ensure deletedPanelChatIDs exists and is an array
        if (!Array.isArray(parsedUncommitted.deletedChats.deletedPanelChatIDs)) {
            parsedUncommitted.deletedChats.deletedPanelChatIDs = [];
            log(`'deletedPanelChatIDs' was undefined or not an array in uncommitted changes. Initialized as empty array.`, LogLevel.WARN);
        }

        // Ensure deletedMessageIDs exists and is an array
        if (!Array.isArray(parsedUncommitted.deletedChats.deletedMessageIDs)) {
            parsedUncommitted.deletedChats.deletedMessageIDs = [];
            log(`'deletedMessageIDs' was undefined or not an array in uncommitted changes. Initialized as empty array.`, LogLevel.WARN);
        }

        const uncommittedDeletedPanelChatIds = new Set(parsedUncommitted.deletedChats.deletedPanelChatIDs);
        const uncommittedDeletedMessageIds = new Set(parsedUncommitted.deletedChats.deletedMessageIDs);

        // Aggregate all panelChats from uncommitted changes, excluding deleted ones
        const allCurrentPanelChats: PanelChat[] = parsedUncommitted.panelChats.filter(pc => 
            !uncommittedDeletedPanelChatIds.has(pc.id)
        ).map(pc => {
            const filteredMessages = pc.messages.filter(msg => 
                !uncommittedDeletedMessageIds.has(msg.id) && currentMessageIds.has(msg.id)
            );
            return {
                ...pc,
                messages: filteredMessages
            };
        }).filter(pc => pc.messages.length > 0);

        log(`Aggregated ${allCurrentPanelChats.length} uncommitted PanelChats.`, LogLevel.INFO);

        if (allCurrentPanelChats.length > 0) {
            uncommitted = {
                panelChats: allCurrentPanelChats,
            };
            log(`Found ${allCurrentPanelChats.length} uncommitted new panelChats.`, LogLevel.INFO);
        } else {
            log("No uncommitted new panelChats found.", LogLevel.INFO);
        }
    }

    log("Returning commits and uncommitted data.", LogLevel.INFO);
    log(`Total Commits: ${allCommits.length}`, LogLevel.INFO);
    if (uncommitted) {
        log(`Uncommitted PanelChats: ${uncommitted.panelChats.length}`, LogLevel.INFO);
    } else {
        log(`No uncommitted changes.`, LogLevel.INFO);
    }
    return {
        commits: allCommits,
        uncommitted,
    };
}

export async function getGitHistoryThatTouchesFile(repoPath: string, filePath: string, targetFilePath: string): Promise<GitHistoryData> {
    const git: SimpleGit = simpleGit(repoPath);

    console.log("Starting getGitHistoryThatTouchesFile");

    // Ensure both files exist in the repository
    const absoluteFilePath = path.resolve(repoPath, filePath);
    const absoluteTargetFilePath = path.resolve(repoPath, targetFilePath);
    if (!fs.existsSync(absoluteFilePath)) {
        throw new Error(`File not found: ${absoluteFilePath}`);
    }
    if (!fs.existsSync(absoluteTargetFilePath)) {
        throw new Error(`Target file not found: ${absoluteTargetFilePath}`);
    }

    // Step 1: Read the current stashedPanelChats.json to collect existing message and panelChat IDs
    let currentContent: string;
    let parsedCurrent: StashedState;
    const currentMessageIds: Set<string> = new Set();
    const currentPanelChatIds: Set<string> = new Set();

    try {
        currentContent = fs.readFileSync(absoluteFilePath, 'utf-8');
        console.log(`Successfully read ${absoluteFilePath}`);
    } catch (error) {
        console.warn(`Warning: Failed to read current file content: ${(error as Error).message}`);
        // If reading fails, initialize with default structure
        currentContent = JSON.stringify({
            panelChats: [],
            schemaVersion: SCHEMA_VERSION,
            deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
        }, null, 2);
        console.log(`Initialized default stashedPanelChats.json structure.`);
    }

    try {
        parsedCurrent = JSON.parse(currentContent);
        if (!isStashedState(parsedCurrent)) {
            throw new Error('Parsed content does not match StashedState structure.');
        }
        console.log(`Parsed current stashedPanelChats.json successfully.`);
    } catch (error) {
        console.warn(`Warning: Failed to parse current JSON content: ${(error as Error).message}`);
        // Initialize with default structure if parsing fails
        parsedCurrent = {
            panelChats: [],
            schemaVersion: SCHEMA_VERSION,
            deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
        };
        console.log(`Initialized default stashedPanelChats.json structure due to parsing failure.`);
    }

    // Ensure deletedChats exists
    if (!parsedCurrent.deletedChats) {
        parsedCurrent.deletedChats = { deletedMessageIDs: [], deletedPanelChatIDs: [] };
        console.warn(`'deletedChats' was undefined. Initialized with empty arrays.`);
    }

    // Ensure deletedPanelChatIDs exists and is an array
    if (!Array.isArray(parsedCurrent.deletedChats.deletedPanelChatIDs)) {
        parsedCurrent.deletedChats.deletedPanelChatIDs = [];
        console.warn(`'deletedPanelChatIDs' was undefined or not an array. Initialized as empty array.`);
    }

    // Ensure deletedMessageIDs exists and is an array
    if (!Array.isArray(parsedCurrent.deletedChats.deletedMessageIDs)) {
        parsedCurrent.deletedChats.deletedMessageIDs = [];
        console.warn(`'deletedMessageIDs' was undefined or not an array. Initialized as empty array.`);
    }

    const deletedPanelChatIds = new Set(parsedCurrent.deletedChats.deletedPanelChatIDs);
    const deletedMessageIds = new Set(parsedCurrent.deletedChats.deletedMessageIDs);

    // Collect all current message and panelChat IDs excluding deleted ones
    for (const panelChat of parsedCurrent.panelChats) {
        if (!deletedPanelChatIds.has(panelChat.id)) {
            currentPanelChatIds.add(panelChat.id);
            for (const message of panelChat.messages) {
                if (!deletedMessageIds.has(message.id)) {
                    currentMessageIds.add(message.id);
                }
            }
        }
    }

    console.log(`Collected ${currentPanelChatIds.size} active PanelChat IDs and ${currentMessageIds.size} active Message IDs.`);

    // Step 2: Get the commit history for the main file with --follow to track renames
    // '--reverse' ensures commits are ordered from oldest to newest
    const logArgs = ['log', '--reverse', '--follow', '--pretty=format:%H%x09%an%x09%ad%x09%s', '--', filePath];

    let logData: string;
    try {
        logData = await git.raw(logArgs);
        console.log(`Retrieved git log data successfully.`);
    } catch (error) {
        throw new Error(`Failed to retrieve git log for ${filePath}: ${(error as Error).message}`);
    }

    const logLines = logData.split('\n').filter(line => line.trim() !== '');
    console.log(`Processing ${logLines.length} commits from git log.`);

    const allCommitsMap: Map<string, CommitData> = new Map();
    const seenMessageIds: Set<string> = new Set();

    for (const line of logLines) {
        console.log("Processing Line: ", line);
        const [commitHash, authorName, dateStr, ...commitMsgParts] = line.split('\t');
        const commitMessage = commitMsgParts.join('\t');

        // Skip commits that are solely for deletions
        if (commitMessage.startsWith('Delete message with ID') || commitMessage.startsWith('Delete PanelChat with ID')) {
            console.log(`Skipping deletion commit ${commitHash}: ${commitMessage}`);
            continue;
        }

        // Check if this commit also modifies the targetFilePath
        let modifiesTargetFile = false;
        try {
            const filesChanged = await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash]);
            const files = filesChanged.split('\n').map(f => f.trim());
            if (files.includes(targetFilePath)) {
                modifiesTargetFile = true;
                console.log(`Commit ${commitHash} modifies target file ${targetFilePath}.`);
            } else {
                console.log(`Commit ${commitHash} does not modify target file ${targetFilePath}. Skipping.`);
            }
        } catch (error) {
            console.warn(`Warning: Failed to retrieve files changed in commit ${commitHash}: ${(error as Error).message}`);
            continue; // Skip this commit
        }

        if (!modifiesTargetFile) {
            continue; // Already logged above
        }

        // Get the file content at this commit
        let fileContent: string;
        try {
            fileContent = await git.raw(['show', `${commitHash}:${filePath}`]);
            console.log(`Retrieved file content for commit ${commitHash}.`);
        } catch (error) {
            console.warn(`Warning: Could not retrieve file at commit ${commitHash}. It might have been deleted or renamed.`);
            continue; // Skip this commit
        }

        // Parse the JSON content as StashedState
        let parsedContent: StashedState;
        try {
            parsedContent = JSON.parse(fileContent);
            if (!isStashedState(parsedContent)) {
                throw new Error('Parsed content does not match StashedState structure.');
            }
            console.log(`Parsed stashedPanelChats.json for commit ${commitHash} successfully.`);
        } catch (error) {
            console.warn(`Warning: Failed to parse JSON for commit ${commitHash}: ${(error as Error).message}`);
            console.warn(`Content: ${fileContent}`);
            continue; // Skip this commit
        }

        // Initialize or retrieve existing CommitData for this commit
        let commitData = allCommitsMap.get(commitHash);
        if (!commitData) {
            commitData = {
                commitHash,
                date: new Date(dateStr),
                commitMessage,
                author: authorName,
                panelChats: [], // Initialize panelChats
            };
            allCommitsMap.set(commitHash, commitData);
            console.log(`Initialized CommitData for commit ${commitHash}.`);
        }

        // Process the commit's panelChats
        processCommit(parsedContent, currentMessageIds, currentPanelChatIds, seenMessageIds, commitData, commitHash);
    }

    // Convert the map to an array
    let allCommits: CommitData[] = Array.from(allCommitsMap.values());

    // **New Addition:** Filter out commits with empty panelChats
    allCommits = allCommits.filter(commit => commit.panelChats.some(pc => pc.messages.length > 0));
    console.log(`Filtered commits to exclude empty ones. Remaining commits count: ${allCommits.length}`);

    // Step 3: Check for uncommitted changes
    let status;
    try {
        status = await git.status();
        console.log(`Retrieved git status successfully.`);
    } catch (error) {
        throw new Error(`Failed to retrieve git status: ${(error as Error).message}`);
    }

    let uncommitted: UncommittedData | null = null;
    console.log("Checking uncommitted changes");
    if (
        status.modified.includes(filePath) ||
        status.not_added.includes(filePath) ||
        status.created.includes(filePath)
    ) {
        // Get the current (uncommitted) file content
        console.log("stashedPanelChats.json is modified");
        let currentUncommittedContent: string;
        try {
            currentUncommittedContent = fs.readFileSync(absoluteFilePath, 'utf-8');
            console.log(`Successfully read uncommitted stashedPanelChats.json.`);
        } catch (error) {
            console.warn(`Warning: Failed to read current file content: ${(error as Error).message}`);
            currentUncommittedContent = JSON.stringify({
                panelChats: [],
                schemaVersion: SCHEMA_VERSION,
                deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
            }, null, 2); // Default to empty StashedState
            console.log(`Initialized default uncommitted stashedPanelChats.json structure.`);
        }

        // Parse the JSON content as StashedState
        let parsedUncommitted: StashedState;
        try {
            parsedUncommitted = JSON.parse(currentUncommittedContent);
            if (!isStashedState(parsedUncommitted)) {
                throw new Error('Parsed content does not match StashedState structure.');
            }
            console.log(`Parsed uncommitted stashedPanelChats.json successfully.`);
        } catch (error) {
            console.warn(`Warning: Failed to parse current JSON content: ${(error as Error).message}`);
            parsedUncommitted = {
                panelChats: [],
                schemaVersion: SCHEMA_VERSION,
                deletedChats: { deletedMessageIDs: [], deletedPanelChatIDs: [] }
            }; // Default to empty StashedState
            console.log(`Initialized default uncommitted stashedPanelChats.json structure due to parsing failure.`);
        }

        // Ensure deletedChats exists
        if (!parsedUncommitted.deletedChats) {
            parsedUncommitted.deletedChats = { deletedMessageIDs: [], deletedPanelChatIDs: [] };
            console.warn(`'deletedChats' was undefined in uncommitted changes. Initialized with empty arrays.`);
        }

        // Ensure deletedPanelChatIDs exists and is an array
        if (!Array.isArray(parsedUncommitted.deletedChats.deletedPanelChatIDs)) {
            parsedUncommitted.deletedChats.deletedPanelChatIDs = [];
            console.warn(`'deletedPanelChatIDs' was undefined or not an array in uncommitted changes. Initialized as empty array.`);
        }

        // Ensure deletedMessageIDs exists and is an array
        if (!Array.isArray(parsedUncommitted.deletedChats.deletedMessageIDs)) {
            parsedUncommitted.deletedChats.deletedMessageIDs = [];
            console.warn(`'deletedMessageIDs' was undefined or not an array in uncommitted changes. Initialized as empty array.`);
        }

        const uncommittedDeletedPanelChatIds = new Set(parsedUncommitted.deletedChats.deletedPanelChatIDs);
        const uncommittedDeletedMessageIds = new Set(parsedUncommitted.deletedChats.deletedMessageIDs);

        // Aggregate all panelChats from uncommitted changes, excluding deleted ones
        const allCurrentPanelChats: PanelChat[] = parsedUncommitted.panelChats.filter(pc => 
            !uncommittedDeletedPanelChatIds.has(pc.id)
        ).map(pc => {
            const filteredMessages = pc.messages.filter(msg => 
                !uncommittedDeletedMessageIds.has(msg.id) && currentMessageIds.has(msg.id)
            );
            return {
                ...pc,
                messages: filteredMessages
            };
        }).filter(pc => pc.messages.length > 0);

        console.log(`Aggregated ${allCurrentPanelChats.length} uncommitted PanelChats.`);

        if (allCurrentPanelChats.length > 0) {
            uncommitted = {
                panelChats: allCurrentPanelChats,
            };
            console.log(`Found ${allCurrentPanelChats.length} uncommitted new panelChats.`);
        } else {
            console.log("No uncommitted new panelChats found.");
        }
    }

    console.log("Returning commits and uncommitted data.");
    console.log(`Total Commits: ${allCommits.length}`);
    if (uncommitted) {
        console.log(`Uncommitted PanelChats: ${uncommitted.panelChats.length}`);
    } else {
        console.log(`No uncommitted changes.`);
    }
    return {
        commits: allCommits,
        uncommitted,
    };
}
