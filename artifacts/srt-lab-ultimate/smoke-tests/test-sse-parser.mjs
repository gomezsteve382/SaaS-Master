// Simulate the frontend SSE parser to find where job token gets lost
const lines = ['event: job', 'data: {"jobToken":"abc-123","analysisId":"XYZ"}', '', ''];
for (const line of lines) {
  if (line.startsWith('data: ')) {
    try {
      const data = JSON.parse(line.slice(6));
      console.log('Parsed data:', JSON.stringify(data));
      console.log('data.jobToken:', data.jobToken);
      console.log('data.type:', data.type);
      // Simulate the if-else chain in Home.tsx
      if (data.phase === 'uploading') {
        console.log('-> MATCHED: phase uploading');
      } else if (data.type === 'agent_start') {
        console.log('-> MATCHED: agent_start');
      } else if (data.type === 'swarm_complete') {
        console.log('-> MATCHED: swarm_complete');
      } else if (data.type === 'venom_start') {
        console.log('-> MATCHED: venom_start');
      } else if (data.type === 'venom_complete') {
        console.log('-> MATCHED: venom_complete');
      } else if (data.type === 'bus_event') {
        console.log('-> MATCHED: bus_event');
      } else if (data.type === 'tool_start') {
        console.log('-> MATCHED: tool_start');
      } else if (data.type === 'tool_end') {
        console.log('-> MATCHED: tool_end');
      } else if (data.type === 'synthesizing') {
        console.log('-> MATCHED: synthesizing');
      } else if (data.type === 'complete') {
        console.log('-> MATCHED: complete');
      } else if (data.message && !data.type) {
        console.log('-> MATCHED: error message');
      } else if (data.jobToken) {
        console.log('-> MATCHED: jobToken handler - POLLING STARTS');
      } else if (data.id && (data.status === 'complete' || data.findings)) {
        console.log('-> MATCHED: final result - NAVIGATE');
      } else {
        console.log('-> NO MATCH - event dropped!');
      }
    } catch (e) {
      console.log('Parse error:', e.message);
    }
  } else {
    console.log('Skipped line:', JSON.stringify(line));
  }
}

console.log('\n--- Now test what happens when result event arrives ---');
const resultLines = ['event: result', 'data: {"id":"abc123","status":"complete","filename":"test.bin"}', '', ''];
for (const line of resultLines) {
  if (line.startsWith('data: ')) {
    try {
      const data = JSON.parse(line.slice(6));
      console.log('Parsed result data:', JSON.stringify(data));
      if (data.id && (data.status === 'complete' || data.findings)) {
        console.log('-> MATCHED: final result - NAVIGATE');
      } else {
        console.log('-> NO MATCH for result event!');
      }
    } catch (e) {
      console.log('Parse error:', e.message);
    }
  }
}
