import { WuchatTool } from '../common/types';
import { WuchatBrowser } from './WuchatBrowser';

export function createBrowserTool(browser: WuchatBrowser): WuchatTool {
	return {
		id: 'wuchat.browser',
		name: 'Wuchat Browser',
		description: 'Controls the visible Chrome window owned by Wuchat. Can navigate, inspect text and HTML, click, fill, press keys and capture screenshots. Requires approval unless automatic approval is enabled.',
		requiresApproval: true,
		inputSchema: 'JSON: {"action":"navigate|snapshot|click|fill|press|inspect|screenshot", "url":"...", "selector":"...", "text":"...", "key":"..."}. Supply fields relevant to the action.',
		async invoke(rawInput) { return browser.runAction(rawInput); }
	};
}
