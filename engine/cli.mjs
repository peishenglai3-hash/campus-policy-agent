#!/usr/bin/env node
import path from 'node:path';
import { DEFAULT_KB_ROOT, getDefaultKB, kbStats, answerSync, renderFiveSections } from './index.mjs';

function readArgs(argv) {
  const args = { command: argv[0] || 'help', json: argv.includes('--json'), kb: null, words: [] };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--kb' && argv[i + 1]) { args.kb = argv[++i]; continue; }
    if (argv[i] === '--json') continue;
    args.words.push(argv[i]);
  }
  return args;
}

const args = readArgs(process.argv.slice(2));
const kb = getDefaultKB(args.kb ? path.resolve(args.kb) : DEFAULT_KB_ROOT);
if (args.command === 'stats') {
  const stats = kbStats(kb);
  process.stdout.write(args.json ? JSON.stringify(stats, null, 2) + '\n' :
    'Knowledge base: ' + stats.root + '\nDocuments: ' + stats.docs + '\nChunks: ' + stats.chunks + '\n');
} else if (args.command === 'ask') {
  const question = args.words.join(' ').trim();
  if (!question) {
    process.stderr.write('Usage: node engine/cli.mjs ask "question" [--json] [--kb <directory>]\n');
    process.exitCode = 1;
  } else {
    const answer = answerSync(question, { kb });
    process.stdout.write(args.json ? JSON.stringify(answer, null, 2) + '\n' : renderFiveSections(answer) + '\n');
  }
} else {
  process.stdout.write([
    'Campus Policy Agent archive',
    '  node engine/cli.mjs stats [--json] [--kb <directory>]',
    '  node engine/cli.mjs ask "question" [--json] [--kb <directory>]',
    '',
  ].join('\n'));
  if (args.command !== 'help') process.exitCode = 1;
}
