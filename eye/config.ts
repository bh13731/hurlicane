export interface EyeConfig {
  webhookSecret: string;
  port: number;
  author: string;            // GitHub username to watch
  orchestratorUrl: string;   // base URL of the Hurlicane server
}

export function loadConfig(): EyeConfig {
  const args = process.argv.slice(2);

  function flag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  const webhookSecret = flag('webhook-secret') ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('Missing required: GITHUB_WEBHOOK_SECRET or --webhook-secret');
    process.exit(1);
  }

  const author = flag('author') ?? process.env.EYE_AUTHOR;
  if (!author) {
    console.error('Missing required: EYE_AUTHOR or --author');
    process.exit(1);
  }

  return {
    webhookSecret,
    port: parseInt(flag('port') ?? process.env.EYE_PORT ?? '4567', 10),
    author,
    orchestratorUrl: flag('orchestrator-url') ?? process.env.EYE_ORCHESTRATOR_URL ?? 'http://localhost:3000',
  };
}
