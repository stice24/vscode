/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ContextBubbleController, CONTEXT_BUBBLE_COMMAND_ID } from './contextBubbleController.js';

// ---------------------------------------------------------------------------
// Register workbench contribution
// ---------------------------------------------------------------------------

// AfterRestored: editors are ready; does not block startup or editor display.
registerWorkbenchContribution2(
	ContextBubbleController.ID,
	ContextBubbleController,
	WorkbenchPhase.AfterRestored,
);

// ---------------------------------------------------------------------------
// Register keybinding
//
// Hotkey: Ctrl+Shift+J (Windows / Linux) | Cmd+Shift+J (macOS)
//
// Audit (src/vs/workbench/contrib/**): Ctrl+Shift+[A-Z] bindings confirmed
// taken for the following letters — B C D E F G I L M O P R S V X Y.
// J is unassigned as a primary Ctrl+Shift binding across all platforms.
// ---------------------------------------------------------------------------

KeybindingsRegistry.registerKeybindingRule({
	id: CONTEXT_BUBBLE_COMMAND_ID,
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyJ,
	when: EditorContextKeys.editorTextFocus,
});
