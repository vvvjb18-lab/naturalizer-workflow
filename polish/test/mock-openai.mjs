// Manual integration helper: a tiny OpenAI-compatible mock that knows the
// sample fixture in samples/. Not part of the test suite.
//   node test/mock-openai.mjs   → listens on 127.0.0.1:8787
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);

function issueList(prompt) {
  const m = prompt.match(/\n# ISSUE LIST\n([\s\S]*?)\n\n# /);
  return m ? JSON.parse(m[1]) : [];
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body);
    const prompt = j.messages?.map((m) => m.content).join('\n') || '';
    let content;

    if (prompt.includes('# DEFECT TYPES')) {
      content = JSON.stringify({
        issues: [
          {
            type: 'structure', severity: 'critical',
            quote: '(1) The effect depends on the task. (2) Supervision matters. (3)',
            problem: 'The prose was converted into a numbered list.',
            fix: 'Turn the three items into prose.',
          },
          {
            type: 'register', severity: 'major',
            quote: 'Remote work is a big deal.',
            problem: 'Colloquial expression.',
            fix: 'Use a formal equivalent.',
          },
          {
            type: 'register', severity: 'minor',
            quote: 'Basically, the gains are conditional, not universal.',
            problem: 'Conversational filler.',
            fix: 'Remove "Basically".',
          },
        ],
      });
    } else if (prompt.includes('# ISSUE LIST')) {
      const issues = issueList(prompt);
      const patches = issues.map((i) => {
        if (i.type === 'structure') {
          return {
            issue: i.id,
            before: i.quote,
            after: 'The effect depends on the task, and supervision matters.',
            note: 'list to prose',
          };
        }
        if (i.quote.includes('big deal')) {
          return {
            issue: i.id,
            before: 'Remote work is a big deal.',
            after: 'Remote work is significant.',
            note: 'formal register',
          };
        }
        return {
          issue: i.id,
          before: 'Basically, the gains are conditional, not universal.',
          after: 'The gains are conditional, not universal.',
          note: 'drop filler',
        };
      });
      content = JSON.stringify({ patches, unresolved: [] });
    } else {
      content = '{"issues":[]}';
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock OpenAI server on http://127.0.0.1:${PORT}/v1`);
});
