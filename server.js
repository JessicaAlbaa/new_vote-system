const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let votes = [];
let currentVoteId = 1;

app.use(express.static('public'));

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  const validInterfaces = ['WLAN', '以太网', 'en0', 'eth0'];
  for (const devName of validInterfaces) {
    const iface = interfaces[devName];
    if (iface) {
      for (const alias of iface) {
        if (alias.family === 'IPv4' && !alias.internal) {
          return alias.address;
        }
      }
    }
  }
  return '0.0.0.0';
}

function getVoteUrl() {
  // 使用Render提供的环境变量
  if (process.env.RENDER_EXTERNAL_URL) {
    return `${process.env.RENDER_EXTERNAL_URL}/vote.html?vid=${currentVoteId}`;
  }
  
  // 本地开发时使用本地IP
  const ipAddress = getLocalIpAddress();
  const PORT = process.env.PORT || 3000;
  return `http://${ipAddress}:${PORT}/vote.html?vid=${currentVoteId}`;
}

app.get('/qrcode', async (req, res) => {
  try {
    const url = getVoteUrl();
    const qr = await QRCode.toDataURL(url);
    res.json({ qr, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/reset', (req, res) => {
  votes = [];
  currentVoteId++;
  QRCode.toDataURL(getVoteUrl(), (err, qr) => {
    res.json({ qr, url: getVoteUrl() });
    io.emit('reset');
  });
});

const dimensionMap = {
  analysis: '综合分析能力',
  plan: '计划统筹能力',
  solve: '计划和解决问题能力',
  reaction: '反应能力',
  speak: '语言表达能力',
  behave: '举止仪表'
};
function processStats() {
  // 1. 初始化 stats 对象
  const stats = {
    total: votes.length,
    trimmedAverages: { A: 0, B: 0, C: 0, D: 0 },
    distribution: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    dimensions: [],
    candidateExtremes: {
      A: {},
      B: {},
      C: {},
      D: {}
    }
  };

  function calculateTrimmedAverage(scores) {
    if (scores.length <= 2) return 0;
    const sorted = [...scores].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1); // 去掉最高最低
    const sum = trimmed.reduce((a, b) => a + b, 0);
    return sum / trimmed.length;
  }

  const candidateScores = { A: [], B: [], C: [], D: [] };
  votes.forEach(vote => {
    candidateScores.A.push(vote.candidates.A);
    candidateScores.B.push(vote.candidates.B);
    candidateScores.C.push(vote.candidates.C);
    candidateScores.D.push(vote.candidates.D);
  });

  stats.trimmedAverages = {
    A: calculateTrimmedAverage(candidateScores.A),
    B: calculateTrimmedAverage(candidateScores.B),
    C: calculateTrimmedAverage(candidateScores.C),
    D: calculateTrimmedAverage(candidateScores.D)
  };

  // 2. 初始化维度极值
  const dimensionKeys = ['analysis', 'plan', 'solve', 'reaction', 'speak', 'behave'];
  dimensionKeys.forEach(dim => {
    const zhDim = dimensionMap[dim]; // 获取中文维度名
    stats.candidateExtremes.A[zhDim] = { max: -Infinity, min: Infinity };
    stats.candidateExtremes.B[zhDim] = { max: -Infinity, min: Infinity };
    stats.candidateExtremes.C[zhDim] = { max: -Infinity, min: Infinity };
    stats.candidateExtremes.D[zhDim] = { max: -Infinity, min: Infinity };
  });

  // 3. 无投票时的处理
  if (votes.length === 0) {
    dimensionKeys.forEach(dim => {
      const zhDim = dimensionMap[dim];
      ['A', 'B', 'C', 'D'].forEach(candidate => {
        stats.candidateExtremes[candidate][zhDim] = { max: 0, min: 0 };
      });
    });
    return stats;
  }

  // 4. 计算分数段分布
  votes.forEach(vote => {
    ['A', 'B', 'C', 'D'].forEach((candidate, index) => {
      const score = vote.candidates[candidate];
      let binIndex = 0;
      if (score < 60) binIndex = 0;
      else if (score < 70) binIndex = 1;
      else if (score < 80) binIndex = 2;
      else if (score < 90) binIndex = 3;
      else binIndex = 4;

      stats.distribution[binIndex][index]++;
    });
  });

  // 转换为百分比
  const totalVotes = votes.length;
  for (let bin = 0; bin < 5; bin++) {
    for (let candidate = 0; candidate < 4; candidate++) {
      stats.distribution[bin][candidate] = ((stats.distribution[bin][candidate] / totalVotes) * 100).toFixed(1);
    }
  }

  // 5. 计算维度平均值
  const dimensionCandidateScores = {
    analysis: { A: [], B: [], C: [], D: [] },
    plan: { A: [], B: [], C: [], D: [] },
    solve: { A: [], B: [], C: [], D: [] },
    reaction: { A: [], B: [], C: [], D: [] },
    speak: { A: [], B: [], C: [], D: [] },
    behave: { A: [], B: [], C: [], D: [] }
  };

  votes.forEach(vote => {
    Object.entries(vote.dimensions).forEach(([dimension, candidateScores]) => {
      Object.entries(candidateScores).forEach(([candidate, score]) => {
        dimensionCandidateScores[dimension][candidate].push(score);
      });
    });
  });

  stats.dimensions = Object.entries(dimensionCandidateScores).map(([dimensionKey, candidateMap]) => {
    const dimension = dimensionMap[dimensionKey]; // 转换为中文维度名
    const candidateAverages = {};
    for (const [candidate, scores] of Object.entries(candidateMap)) {
      candidateAverages[candidate] = scores.length
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;
    }

    const maxEntry = Object.entries(candidateAverages).reduce((a, b) => (b[1] > a[1] ? b : a));
    const minEntry = Object.entries(candidateAverages).reduce((a, b) => (b[1] < a[1] ? b : a));

    return {
      name: dimension,
      maxCandidate: maxEntry[0],
      maxScore: maxEntry[1].toFixed(1),
      minCandidate: minEntry[0],
      minScore: minEntry[1].toFixed(1)
    };
  });

  // 6. 计算每个候选人每个维度的最高分和最低分
  votes.forEach(vote => {
    if (!vote.dimensions) return;

    dimensionKeys.forEach(dim => {
      const scores = vote.dimensions[dim];
      if (!scores) return;

      const zhDim = dimensionMap[dim]; // 转换为中文维度名
      ['A', 'B', 'C', 'D'].forEach(candidate => {
        const score = scores[candidate];
        if (score === undefined) return;

        const current = stats.candidateExtremes[candidate][zhDim];
        if (score > current.max) current.max = score;
        if (score < current.min) current.min = score;
      });
    });
  });

  return stats;
}
io.on('connection', (socket) => {
  console.log(`新连接: ${socket.id}`);

  socket.on('vote', (data, callback) => {
    try {
      // 验证数据
      if (
        !data.candidates ||
        typeof data.candidates.A !== 'number' ||
        typeof data.candidates.B !== 'number' ||
        typeof data.candidates.C !== 'number' ||
        typeof data.candidates.D !== 'number'
      ) {
        throw new Error('无效的投票数据');
      }

      // 存储投票
      votes.push({
        candidates: data.candidates,
        dimensions: data.dimensions
      });

      console.log(`收到投票，当前总数: ${votes.length}`);

      const stats = processStats();
      io.emit('update', stats);

      if (callback) callback('OK'); // ✅ 安全调用
    } catch (err) {
      console.error('投票错误:', err.message);
      if (callback) callback('ERROR'); // ✅ 防止 callback 未定义报错
    }
  });

  socket.on('requestUpdate', () => {
    socket.emit('update', processStats());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
================================
服务已启动：
访问地址: http://localhost:${PORT}
================================
  `);
});
