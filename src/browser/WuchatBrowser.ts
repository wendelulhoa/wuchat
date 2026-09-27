import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { chromium, Browser, CDPSession, Page } from 'playwright-core';

const CHROME_PATHS = [
	process.env.CHROME_PATH,
	'/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
	'/usr/bin/chromium', '/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter((value): value is string => !!value);

interface TabEntry {
	page: Page;
	cdp?: CDPSession;
}

/**
 * Wuchat Browser: a Chrome/Chromium tab rendered live inside VS Code.
 * Uses the DevTools protocol screencast so the page behaves like a real
 * browser view (animations, focus, hover, native scrolling), while keeping
 * Playwright element picking for the Wuchat chat.
 */
export class WuchatBrowser implements vscode.Disposable {
	private browser?: Browser;
	private tabs = new Map<string, TabEntry>();
	private activeId?: string;
	private panel?: vscode.WebviewPanel;
	private onElement?: (description: string) => Promise<void>;
	private onScreenshot?: (data: Uint8Array, url: string) => Promise<void>;

	setContextHandlers(
		onElement: (description: string) => Promise<void>,
		onScreenshot: (data: Uint8Array, url: string) => Promise<void>
	): void {
		this.onElement = onElement;
		this.onScreenshot = onScreenshot;
	}

	private async ensureBrowser(): Promise<Browser> {
		if (this.browser?.isConnected()) return this.browser;
		const executablePath = CHROME_PATHS.find(existsSync);
		if (!executablePath) throw new Error('Chrome or Chromium is required for Wuchat Browser. Set CHROME_PATH to its executable.');
		this.browser = await chromium.launch({ executablePath, headless: true });
		return this.browser;
	}

	private async ensurePage(): Promise<Page> {
		const active = this.activeId ? this.tabs.get(this.activeId) : undefined;
		if (active && !active.page.isClosed()) return active.page;
		return this.newTab();
	}

	private async newTab(url = 'about:blank'): Promise<Page> {
		const browser = await this.ensureBrowser();
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
		const page = await context.newPage();
		const id = `tab-${this.tabs.size + 1}-${Date.now()}`;
		this.tabs.set(id, { page });
		this.activeId = id;

		page.on('load', () => {
			this.post({ type: 'navigated', url: page.url(), tabs: this.tabList() });
			void this.startScreencast(id);
		});
		page.on('framenavigated', frame => {
			if (frame === page.mainFrame()) this.post({ type: 'navigating', url: frame.url() });
		});
		page.on('crash', () => {
			this.tabs.delete(id);
			if (this.activeId === id) this.activeId = undefined;
			this.post({ type: 'error', text: 'The page crashed. Navigate again to reopen it.' });
		});

		if (url !== 'about:blank') {
			await page.goto(this.normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => { });
		}
		this.post({ type: 'tabs', tabs: this.tabList(), activeId: id });
		await this.startScreencast(id);
		return page;
	}

	private tabList(): Array<{ id: string; title: string; url: string; active: boolean }> {
		const list: Array<{ id: string; title: string; url: string; active: boolean }> = [];
		for (const [id, entry] of this.tabs) {
			if (entry.page.isClosed()) continue;
			const url = entry.page.url();
			const title = url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) || 'New tab';
			list.push({ id, title, url, active: id === this.activeId });
		}
		return list;
	}

	/** Live CDP screencast: the page streams frames while anything changes. */
	private async startScreencast(id: string): Promise<void> {
		const entry = this.tabs.get(id);
		if (!entry || entry.page.isClosed() || entry.cdp) return;
		if (id !== this.activeId) return;
		try {
			const cdp = await entry.page.context().newCDPSession(entry.page);
			entry.cdp = cdp;
			cdp.on('Page.screencastFrame', async (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
				this.post({ type: 'frame', image: event.data, width: event.metadata.deviceWidth, height: event.metadata.deviceHeight, url: entry.page.url() });
				try { await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }); } catch { /* closed */ }
			});
			await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
		} catch {
			// Screencast unsupported: the UI stays on the last frame; actions still work.
			entry.cdp = undefined;
		}
	}

	private normalizeUrl(rawUrl: string): string {
		const value = (rawUrl ?? '').trim();
		if (!value || value === 'about:blank') return 'about:blank';
		if (/^(https?|file):\/\//i.test(value)) return value;
		if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) return `https://${value}`;
		if (value.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}/.test(value)) return `http://${value}`;
		// Not a URL — treat it as a web search, like a normal address bar.
		return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
	}

	async open(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		this.panel = vscode.window.createWebviewPanel('wuchat.browser', 'Wuchat Browser', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true
		});
		this.panel.webview.html = browserHtml(this.panel.webview);
		this.panel.onDidDispose(() => {
			this.panel = undefined;
			for (const entry of this.tabs.values()) {
				if (!entry.page.isClosed()) void entry.page.context().close();
			}
			this.tabs.clear();
			this.activeId = undefined;
		});
		this.panel.webview.onDidReceiveMessage(message => { void this.handleMessage(message); });
		try {
			const page = await this.ensurePage();
			this.post({ type: 'tabs', tabs: this.tabList(), activeId: this.activeId });
			this.post({ type: 'navigated', url: page.url(), tabs: this.tabList() });
		} catch (error) {
			this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handleMessage(message: { type?: string; url?: string; text?: string; x?: number; y?: number; dy?: number; key?: string; tabId?: string; picking?: boolean }): Promise<void> {
		try {
			const page = await this.ensurePage();
			switch (message.type) {
				case 'ready': return;
				case 'navigate': await this.navigate(message.url || 'about:blank'); break;
				case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => { }); break;
				case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => { }); break;
				case 'refresh': await page.reload({ waitUntil: 'domcontentloaded' }); break;
				case 'newTab': await this.newTab(message.url || 'about:blank'); break;
				case 'closeTab': {
					const id = message.tabId ?? this.activeId;
					if (!id) break;
					const entry = this.tabs.get(id);
					this.tabs.delete(id);
					if (entry && !entry.page.isClosed()) await entry.page.context().close().catch(() => { });
					if (this.activeId === id) this.activeId = [...this.tabs.keys()].pop();
					if (!this.activeId) await this.newTab();
					else this.post({ type: 'tabs', tabs: this.tabList(), activeId: this.activeId });
					break;
				}
				case 'switchTab': {
					if (message.tabId && this.tabs.has(message.tabId)) {
						this.activeId = message.tabId;
						await this.startScreencast(message.tabId);
						this.post({ type: 'tabs', tabs: this.tabList(), activeId: this.activeId });
					}
					break;
				}
				case 'click': await page.mouse.click(message.x || 0, message.y || 0); break;
				case 'dblclick': await page.mouse.dblclick(message.x || 0, message.y || 0); break;
				case 'rightclick': await page.mouse.click(message.x || 0, message.y || 0, { button: 'right' }); break;
				case 'hover': {
					await page.mouse.move(message.x || 0, message.y || 0);
					if (message.picking) {
						const target = await this.describeAt(page, message.x || 0, message.y || 0);
						this.post({ type: 'hovered', target });
					}
					return;
				}
				case 'type': await page.keyboard.insertText(message.text || ''); break;
				case 'key': await page.keyboard.press(message.key || 'Enter'); break;
				case 'scroll': await page.mouse.wheel(0, message.dy || 0); break;
				case 'select': {
					const description = await this.elementAt(page, message.x || 0, message.y || 0);
					if (description && this.onElement) await this.onElement(description);
					this.post({ type: 'selected', text: description ? 'Element added to Wuchat chat' : 'No element found' });
					break;
				}
				case 'screenshot': {
					const data = await page.screenshot({ type: 'png', fullPage: false });
					if (this.onScreenshot) await this.onScreenshot(data, page.url());
					this.post({ type: 'selected', text: 'Screenshot added to Wuchat chat' });
					break;
				}
				default: return;
			}
			this.post({ type: 'navigated', url: page.url(), tabs: this.tabList() });
		} catch (error) {
			this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
		}
	}

	private post(message: unknown): void { void this.panel?.webview.postMessage(message); }

	async navigate(rawUrl: string): Promise<string> {
		const page = await this.ensurePage();
		const url = this.normalizeUrl(rawUrl);
		this.post({ type: 'navigating', url });
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.post({ type: 'error', text: `Could not open ${url}: ${message}` });
			return `Failed to open ${url}: ${message}`;
		}
		this.post({ type: 'navigated', url: page.url(), tabs: this.tabList() });
		return `Opened ${page.url()}`;
	}

	private async describeAt(page: Page, x: number, y: number): Promise<{ label: string; rect: { x: number; y: number; width: number; height: number } } | undefined> {
		return page.evaluate(({ x, y }) => {
			const element = document.elementFromPoint(x, y);
			if (!element || element === document.documentElement || element === document.body) return undefined;
			const tag = element.tagName.toLowerCase();
			const id = element.id ? `#${element.id}` : '';
			const classes = Array.from(element.classList).slice(0, 2).map(name => `.${name}`).join('');
			const role = element.getAttribute('role');
			const accessibleName = element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.placeholder : '') || (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90);
			const rect = element.getBoundingClientRect();
			return { label: `${tag}${id}${classes}${role ? ` [${role}]` : ''}${accessibleName ? ` · ${accessibleName}` : ''}`, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
		}, { x, y });
	}

	private async elementAt(page: Page, x: number, y: number): Promise<string> {
		return page.evaluate(({ x, y }) => {
			const element = document.elementFromPoint(x, y);
			if (!element) return '';
			const tag = element.tagName.toLowerCase();
			const id = element.id ? `#${element.id}` : '';
			const classes = Array.from(element.classList).slice(0, 3).map(name => `.${name}`).join('');
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			const selector = `${tag}${id}${classes}`;
			return `Page: ${location.href}\nSelector: ${selector}\nBounds: x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, width=${Math.round(rect.width)}, height=${Math.round(rect.height)}\nText: ${(element.textContent || '').trim().slice(0, 3000)}\nHTML: ${element.outerHTML.slice(0, 12000)}\nStyles: color=${style.color}; background=${style.backgroundColor}; display=${style.display}; font=${style.font}`;
		}, { x, y });
	}

	async runAction(rawInput: string): Promise<string> {
		let input: { action?: string; url?: string; selector?: string; text?: string; key?: string };
		try { input = JSON.parse(rawInput); } catch { throw new Error('Wuchat Browser expects JSON with action and optional url, selector, text or key.'); }
		const page = await this.ensurePage();
		let result: string;
		switch (input.action) {
			case 'navigate': result = await this.navigate(input.url || 'about:blank'); break;
			case 'click': if (!input.selector) throw new Error('selector is required'); await page.locator(input.selector).first().click({ timeout: 15_000 }); result = `Clicked ${input.selector}`; break;
			case 'fill': if (!input.selector) throw new Error('selector is required'); await page.locator(input.selector).first().fill(input.text || '', { timeout: 15_000 }); result = `Filled ${input.selector}`; break;
			case 'press': await page.keyboard.press(input.key || 'Enter'); result = `Pressed ${input.key || 'Enter'}`; break;
			case 'snapshot': result = (await page.locator('body').ariaSnapshot()).slice(0, 20_000); break;
			case 'screenshot': {
				const data = await page.screenshot({ type: 'png' });
				if (this.onScreenshot) await this.onScreenshot(data, page.url());
				result = `Screenshot of ${page.url()} added to Wuchat chat`;
				break;
			}
			case 'inspect': {
				if (!input.selector) throw new Error('selector is required');
				result = await page.locator(input.selector).first().evaluate(element => element.outerHTML.slice(0, 12000));
				break;
			}
			default: throw new Error('Actions: navigate, click, fill, press, snapshot, screenshot, inspect.');
		}
		return result;
	}

	dispose(): void {
		this.panel?.dispose();
		void this.browser?.close();
	}
}

function browserHtml(webview: vscode.Webview): string {
	const nonce = Math.random().toString(36).slice(2);
	return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
	*{box-sizing:border-box}
	body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:var(--vscode-font-size) var(--vscode-font-family);overflow:hidden}
	button{border:1px solid transparent;border-radius:6px;background:transparent;color:var(--vscode-foreground);padding:5px 8px;cursor:pointer;font:inherit;line-height:1.2}
	button:hover{background:var(--vscode-toolbar-hoverBackground)}
	button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
	input{border:1px solid var(--vscode-input-border,#5555);border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:6px 9px;font:inherit}
	.toolbar{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);align-items:center;flex-shrink:0}
	#url{flex:1;min-width:0}
	#tabs{display:flex;gap:4px;padding:4px 8px 0;overflow-x:auto;flex-shrink:0;scrollbar-width:thin}
	#tabs:empty{display:none}
	.tab{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--vscode-panel-border);border-bottom:none;border-radius:6px 6px 0 0;padding:4px 8px;max-width:220px;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:12px;white-space:nowrap}
	.tab.active{background:var(--vscode-editor-background);color:var(--vscode-foreground)}
	.tab span{overflow:hidden;text-overflow:ellipsis}
	.tab button{padding:0 2px;font-size:11px}
	.screen{position:relative;flex:1;overflow:auto;display:flex;align-items:flex-start;justify-content:center;background:var(--vscode-editorWidget-background,#1e1e1e)}
	.screen img{width:100%;max-width:1440px;height:auto;cursor:pointer;user-select:none;display:block}
	.screen.picking img{cursor:crosshair}
	#loading{position:absolute;top:10px;right:12px;display:none;align-items:center;gap:8px;padding:4px 10px;border-radius:12px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border);font-size:11px;color:var(--vscode-descriptionForeground);z-index:5}
	#loading.on{display:flex}.spin{width:10px;height:10px;border:2px solid var(--vscode-descriptionForeground);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
	#pick-highlight{position:absolute;display:none;z-index:3;pointer-events:none;border:2px solid #987cff;background:#987cff25;border-radius:3px;box-shadow:0 0 0 1px #181820aa}
	#pick-highlight-label{position:absolute;left:-2px;top:-25px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 7px;border-radius:4px;background:#7254d8;color:white;font:11px/1.4 var(--vscode-font-family, sans-serif);box-shadow:0 2px 8px #0007}
	#status{padding:4px 10px;color:var(--vscode-descriptionForeground);font-size:11px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	</style></head><body>
	<div class="toolbar">
		<button id="back" title="Back">←</button><button id="forward" title="Forward">→</button><button id="refresh" title="Reload">↻</button>
		<input id="url" aria-label="Address" placeholder="Search or enter address" spellcheck="false"><button id="go" title="Go">Go</button>
		<button id="newtab" title="New tab">＋</button>
		<button id="select" title="Click a page element to add it to Wuchat">Pick element</button>
		<button id="capture" title="Attach screenshot to Wuchat">Screenshot</button>
	</div>
	<div id="tabs"></div>
	<div class="screen" id="screen">
		<img id="frame" alt="Browser page">
		<div id="pick-highlight"><span id="pick-highlight-label"></span></div>
		<div id="loading"><div class="spin"></div>Loading…</div>
	</div>
	<div id="status">Wuchat Browser · live page. Click links, type in fields and scroll normally; use Pick element or Screenshot to send context to the chat.</div>
	<script nonce="${nonce}">
	const api=acquireVsCodeApi(),frame=document.getElementById('frame'),url=document.getElementById('url'),status=document.getElementById('status'),pick=document.getElementById('select'),highlight=document.getElementById('pick-highlight'),highlightLabel=document.getElementById('pick-highlight-label'),screen=document.getElementById('screen'),loading=document.getElementById('loading'),tabsBar=document.getElementById('tabs');
	let selecting=false,pageW=1440,pageH=900;
	const post=(type,extra={})=>api.postMessage({type,...extra});
	const mapXY=e=>{const r=frame.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)*pageW/r.width),y:Math.round((e.clientY-r.top)*pageH/r.height)}};
	document.getElementById('go').onclick=()=>post('navigate',{url:url.value});
	url.onkeydown=e=>{if(e.key==='Enter'){post('navigate',{url:url.value});url.blur()}};
	document.getElementById('back').onclick=()=>post('back');document.getElementById('forward').onclick=()=>post('forward');document.getElementById('refresh').onclick=()=>post('refresh');document.getElementById('capture').onclick=()=>post('screenshot');
	document.getElementById('newtab').onclick=()=>post('newTab');
	pick.onclick=()=>{selecting=!selecting;pick.classList.toggle('active',selecting);screen.classList.toggle('picking',selecting);highlight.style.display='none';status.textContent=selecting?'Move over the page to highlight an element, then click to add it.':'Wuchat Browser'};
	frame.addEventListener('wheel',e=>{e.preventDefault();post('scroll',{dy:e.deltaY})},{passive:false});
	frame.addEventListener('pointermove',e=>{const p=mapXY(e);post('hover',{x:p.x,y:p.y,picking:selecting})});
	frame.addEventListener('pointerleave',()=>{highlight.style.display='none'});
	frame.onclick=e=>{const p=mapXY(e);if(selecting){post('select',{x:p.x,y:p.y});selecting=false;pick.classList.remove('active');screen.classList.remove('picking');highlight.style.display='none';status.textContent='Adding selected element to Wuchat…'}else{post('click',{x:p.x,y:p.y})}};
	frame.ondblclick=e=>{if(!selecting){const p=mapXY(e);post('dblclick',{x:p.x,y:p.y})}};
	frame.oncontextmenu=e=>{e.preventDefault();const p=mapXY(e);post('rightclick',{x:p.x,y:p.y})};
	// Keyboard events go to the real page so typing and shortcuts work naturally.
	window.addEventListener('keydown',e=>{if(e.target===url)return;const named=['Enter','Backspace','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Delete','Home','End','PageDown','PageUp'];const key=named.includes(e.key)?e.key:(e.key.length===1?e.key:null);if(!key)return;if(key!=='Enter'&&key.length>1||key.length===1&&!(e.ctrlKey||e.metaKey))e.preventDefault();post('key',{key})});
	function renderTabs(tabs){tabsBar.innerHTML='';for(const t of tabs){const el=document.createElement('div');el.className='tab'+(t.active?' active':'');const label=document.createElement('span');label.textContent=t.title;label.title=t.url;const close=document.createElement('button');close.textContent='×';close.title='Close tab';close.onclick=e=>{e.stopPropagation();post('closeTab',{tabId:t.id})};el.append(label,close);el.onclick=()=>post('switchTab',{tabId:t.id});tabsBar.append(el)}}
	window.addEventListener('message',e=>{const m=e.data;
		if(m.type==='frame'){const src='data:image/jpeg;base64,'+m.image;const probe=new Image();probe.onload=()=>{pageW=m.width||pageW;pageH=m.height||pageH;frame.src=src};probe.src=src;if(document.activeElement!==url&&m.url)url.value=m.url;loading.classList.remove('on')}
		else if(m.type==='navigating'){loading.classList.add('on');if(document.activeElement!==url&&m.url)url.value=m.url}
		else if(m.type==='navigated'){loading.classList.remove('on');if(m.url&&document.activeElement!==url)url.value=m.url;renderTabs(m.tabs||[])}
		else if(m.type==='tabs'){renderTabs(m.tabs||[])}
		else if(m.type==='hovered'){if(!m.target){highlight.style.display='none';return}const ir=frame.getBoundingClientRect(),sr=screen.getBoundingClientRect(),sx=ir.width/pageW,sy=ir.height/pageH;highlight.style.display='block';highlight.style.left=(ir.left-sr.left+m.target.rect.x*sx)+'px';highlight.style.top=(ir.top-sr.top+m.target.rect.y*sy)+'px';highlight.style.width=Math.max(4,m.target.rect.width*sx)+'px';highlight.style.height=Math.max(4,m.target.rect.height*sy)+'px';highlightLabel.textContent=m.target.label;status.textContent=m.target.label+' · click to add'}
		else if(m.type==='selected'||m.type==='error')status.textContent=m.text});
	post('ready');
	</script></body></html>`;
}
