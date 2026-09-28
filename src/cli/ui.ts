/*---------------------------------------------------------------------------------------------
 *  Wuchat — lightweight terminal UI for the standalone CLI: colored header,
 *  prompt marker, dim helper and an interval spinner for in-flight requests.
 *--------------------------------------------------------------------------------------------*/

const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[33m';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface CliUi {
	header(sessionId: string): void;
	prompt(): string;
	dim(text: string): string;
	spinner(label: string): { start(): void; stop(): void };
}

function colorEnabled(): boolean {
	return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

function paint(enabled: boolean, code: string, text: string): string {
	return enabled ? `${code}${text}${RESET}` : text;
}

export function createCliUi(providerName: string, model: string): CliUi {
	const colors = colorEnabled();
	return {
		header(sessionId) {
			const line = paint(colors, CYAN, '◆ Wuchat');
			const meta = paint(colors, GRAY, `${providerName} · ${model || 'auto'} · ${process.cwd()} · ${sessionId}`);
			console.log(`${line}  ${meta}`);
			console.log(paint(colors, GRAY, '/model choose model · /sessions list saved · /exit quit'));
		},
		prompt() {
			return paint(colors, YELLOW, '❯ ');
		},
		dim(text: string) {
			return paint(colors, GRAY, text);
		},
		spinner(label) {
			let timer: NodeJS.Timeout | undefined;
			let frame = 0;
			return {
				start() {
					if (timer || !colorEnabled()) return;
					timer = setInterval(() => {
						process.stdout.write(`\r${paint(colors, CYAN, FRAMES[frame % FRAMES.length])} ${paint(colors, GRAY, label)}   `);
						frame++;
					}, 80);
				},
				stop() {
					if (!timer) return;
					clearInterval(timer);
					timer = undefined;
					process.stdout.write('\r\x1b[K');
				}
			};
		}
	};
}
