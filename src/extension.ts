import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as Inline from './inline';
import * as InlineDecoration from './inlinedecoration';
import { PanelViewProvider } from './panelview';
import { monitorPanelChatAsync } from './panelChats';
import * as VSCodeReader from './vscode/vscodeReader';
import { panelChatsToMarkdown } from './panelChatsToMarkdown';
import { PanelChat } from './types';
import * as CursorReader from './cursor/cursorReader';
import { activateGaitParticipant } from './vscode/gaitChatParticipant';
import { checkTool, TOOL } from './ide';
import { StateReader } from './types';
import { generateKeybindings } from './keybind';

const GAIT_FOLDER_NAME = '.gait';

let disposibleDecorations: { decorationTypes: vscode.Disposable[], hoverProvider: vscode.Disposable } | undefined;
let decorationsActive = true;

/**
 * Function to redecorate the editor.
 */
function redecorate(context: vscode.ExtensionContext) {
    if (disposibleDecorations) {
        disposibleDecorations.decorationTypes.forEach(decoration => decoration.dispose());
        disposibleDecorations.hoverProvider.dispose();
    }

    if (decorationsActive) {
        disposibleDecorations = InlineDecoration.decorateActive(context);
    }
}

/**
 * Creates the .gait folder and necessary files if they don't exist.
 */
function createGaitFolderIfNotExists(workspaceFolder: vscode.WorkspaceFolder) {
    const gaitFolderPath = path.join(workspaceFolder.uri.fsPath, GAIT_FOLDER_NAME);
    if (!fs.existsSync(gaitFolderPath)) {
        fs.mkdirSync(gaitFolderPath);
        vscode.window.showInformationMessage(`${GAIT_FOLDER_NAME} folder created successfully`);
    }


    const gitAttributesPath = path.join(workspaceFolder.uri.fsPath, '.gitattributes');
    const gitAttributesContent = fs.existsSync(gitAttributesPath)
        ? fs.readFileSync(gitAttributesPath, 'utf-8')
        : '';

    if (!gitAttributesContent.includes(`${GAIT_FOLDER_NAME}/ -diff`)) {
        fs.appendFileSync(gitAttributesPath, `\n${GAIT_FOLDER_NAME}/ -diff\n`);
        vscode.window.showInformationMessage('.gitattributes updated successfully');
    }
}

/**
 * Activates the extension.
 */
export function activate(context: vscode.ExtensionContext) {
    const tool: TOOL = checkTool();

    generateKeybindings(context, tool);

    const startInlineCommand = tool === "Cursor" ? "aipopup.action.modal.generate" : "inlineChat.start";
    const startPanelCommand = tool === "Cursor" ? "aichat.newchataction" : "workbench.action.chat.openInSidebar";

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found. Extension activation failed.');
        return;
    }

    createGaitFolderIfNotExists(workspaceFolder);

    const stateReader: StateReader = tool === 'Cursor' ? new CursorReader.CursorReader(context) : new VSCodeReader.VSCodeReader(context);

    setTimeout(() => {
        monitorPanelChatAsync(stateReader);
    }, 3000); // Delay to ensure initial setup

    const provider = new PanelViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } })
    );

    console.log('WebviewViewProvider registered for', PanelViewProvider.viewType);

    const updateSidebarCommand = vscode.commands.registerCommand('gait-copilot.updateSidebar', async () => {
        vscode.window.showInformationMessage('Updating sidebar content');
        try {
            provider.updateContent();
        } catch (error) {
            vscode.window.showErrorMessage(`Error updating sidebar: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    const inlineChatStartOverride = vscode.commands.registerCommand('gait-copilot.startInlineChat', () => {
        // Display an information message
        vscode.window.showInformationMessage('Starting inline chat...');
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const document = editor.document;
            const selection = editor.selection;
            const inlineStartInfo: Inline.InlineStartInfo = {
                fileName: vscode.workspace.asRelativePath(document.uri),
                content: document.getText(),
                lineCount: document.lineCount,
                startTimestamp: new Date().toISOString(),
                startSelection: selection.start,
                endSelection: selection.end,
                selectionContent: document.getText(selection),
                parent_inline_chat_id: null,
            };
            stateReader.startInline(inlineStartInfo).catch((error) => {
                vscode.window.showErrorMessage(`Failed to initialize extension: ${error instanceof Error ? error.message : 'Unknown error'}`);
            });
        }
        vscode.commands.executeCommand(startInlineCommand);
    });


    const inlineChatContinue = vscode.commands.registerCommand('gait-copilot.continueInlineChat', (args) => {
        try {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                try {
                    // Create a selection from the start line to the end line
                    const startPosition = new vscode.Position(args.startLine, 0);
                    const endPosition = new vscode.Position(args.endLine, editor.document.lineAt(args.endLine).text.length);
                    const newSelection = new vscode.Selection(startPosition, endPosition);

                    // Set the new selection
                    editor.selection = newSelection;
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to set selection: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }

                const document = editor.document;
                const selection = editor.selection;
                const inlineStartInfo: Inline.InlineStartInfo = {
                    fileName: vscode.workspace.asRelativePath(document.uri),
                    content: document.getText(),
                    lineCount: document.lineCount,
                    startTimestamp: new Date().toISOString(),
                    startSelection: selection.start,
                    endSelection: selection.end,
                    selectionContent: document.getText(selection),
                    parent_inline_chat_id: args.parent_inline_chat_id,
                };
                stateReader.startInline(inlineStartInfo).catch((error) => {
                    vscode.window.showErrorMessage(`Failed to initialize extension: ${error instanceof Error ? error.message : 'Unknown error'}`);
                });
                vscode.commands.executeCommand(startInlineCommand);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to continue inline chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    const inlineChatAcceptOverride = vscode.commands.registerCommand('gait-copilot.acceptInlineChat', () => {
        
        vscode.window.showInformationMessage('accepting inline chat...');
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            stateReader.acceptInline(editor).catch(error => {
                vscode.window.showErrorMessage(`Failed to process editor content: ${error instanceof Error ? error.message : 'Unknown error'}`);
            });

            redecorate(context);
        }
    });

    const openFileWithContentCommand = vscode.commands.registerCommand('gait-copilot.openFileWithContent', async (args) => {
        try {
            // Create a new untitled document
            vscode.workspace.openTextDocument({
                content: args.content,
                language: args.languageId // You can change this to match the content type
            }).then((document) => vscode.window.showTextDocument(document, {
                preview: false, // This will open the document in preview mode
                selection: new vscode.Selection(args.selectionStart, args.selectionEnd)
            }));

            vscode.window.showInformationMessage(`Opened new file: ${args.title}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    // Register the deleteInlineChat command
    const deleteInlineChatCommand = vscode.commands.registerCommand('gait-copilot.removeInlineChat', (args) => {
        console.log("Removing inline chat", args);
        Inline.removeInlineChat(args.filePath, args.inline_chat_id);
        redecorate(context);
    });

    // Register the deletePanelChat command
    const deletePanelChatCommand = vscode.commands.registerCommand('gait-copilot.deletePanelChat', async () => {
        try {
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            const gaitDir = path.join(workspaceFolder.uri.fsPath, GAIT_FOLDER_NAME);
            const stashedPath = path.join(gaitDir, 'stashedPanelChats.json');

            if (!fs.existsSync(stashedPath)) {
                vscode.window.showErrorMessage('stashedPanelChats.json does not exist.');
                return;
            }

            // Read existing chats
            const fileContent = fs.readFileSync(stashedPath, 'utf-8');
            const chats: { messageText: string; responseText: string }[] = JSON.parse(fileContent);

            if (chats.length === 0) {
                vscode.window.showInformationMessage('No chats to delete.');
                return;
            }

            // Prompt user to select which chat to delete
            const items = chats.map((chat, index) => ({
                label: `Chat ${index + 1}`,
                description: `Message: ${chat.messageText.substring(0, 50)}..., Response: ${chat.responseText.substring(0, 50)}...`,
                index: index
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a chat to delete'
            });

            if (!selected) {
                return; // User cancelled the selection
            }

            // Confirm deletion
            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete ${selected.label}?`,
                { modal: true },
                'Yes'
            );

            if (confirm !== 'Yes') {
                return;
            }

            // Remove the selected chat
            chats.splice(selected.index, 1);

            // Write back the updated chats
            fs.writeFileSync(stashedPath, JSON.stringify(chats, null, 2));
            vscode.window.showInformationMessage(`Deleted ${selected.label} successfully.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    // Register command to convert PanelChats to markdown and open in a new file
    const exportPanelChatsToMarkdownCommand = vscode.commands.registerCommand('gait-copilot.exportPanelChatsToMarkdown', async (panelChats: PanelChat[], gitHistory: any) => {
        try {
            const markdownContent = panelChatsToMarkdown(panelChats, gitHistory);
            const document = await vscode.workspace.openTextDocument({
                content: markdownContent,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(document, { preview: false });
            vscode.window.showInformationMessage('Panel chats exported to markdown successfully.');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export panel chats: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });
    const registerGaitChatParticipantCommand = vscode.commands.registerCommand('gait-copilot.registerGaitChatParticipant', (args) => {
        console.log("Registering gait chat participant", args);
        try {
            activateGaitParticipant(context, args.contextString);
            vscode.window.showInformationMessage('Gait chat participant loaded with edit history!');
            vscode.commands.executeCommand(startPanelCommand);
        } catch (error) {
            console.log("Error registering gait chat participant", error);
            vscode.window.showErrorMessage(`Failed to register gait chat participant: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    const activateDecorationsCommand = vscode.commands.registerCommand('gait-copilot.activateDecorations', () => {
        decorationsActive = true;
        redecorate(context);
        vscode.window.showInformationMessage('Decorations activated.');
    });

    const deactivateDecorationsCommand = vscode.commands.registerCommand('gait-copilot.deactivateDecorations', () => {
        decorationsActive = false;
        if (disposibleDecorations) {
            disposibleDecorations.decorationTypes.forEach(decoration => decoration.dispose());
            disposibleDecorations.hoverProvider.dispose();
            disposibleDecorations = undefined;
        }
        vscode.window.showInformationMessage('Decorations deactivated.');
    });

    // Register all commands
    context.subscriptions.push(
        updateSidebarCommand, 
        inlineChatStartOverride, 
        inlineChatContinue, 
        inlineChatAcceptOverride, 
        deleteInlineChatCommand, 
        openFileWithContentCommand,
        activateDecorationsCommand,
        deactivateDecorationsCommand,
        deletePanelChatCommand,
        registerGaitChatParticipantCommand, // Add the new command here
        exportPanelChatsToMarkdownCommand
    );

    redecorate(context);
    vscode.window.onDidChangeActiveTextEditor(() => {
        redecorate(context);
    });
    vscode.workspace.onDidSaveTextDocument(() => {
        redecorate(context);
    });
}

/**
 * Deactivates the extension.
 */
export function deactivate() {}
