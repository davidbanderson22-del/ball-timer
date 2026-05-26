const C = {
  bg: "#fcfbf9",
  card: "#fff",
  text: "#1a1a1a",
  border: "#1a1a1a",
  accent: "#1a1a1a"
};

const PHASE = { TOP: "TOP", BOT: "BOT", WARMUP_TOP: "W_TOP", WARMUP_BOT: "W_BOT" };

const nowHM = () => {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const parseTime = (str) => {
  if (!str) return null;
  const [h, m] = str.split(':').map(Number);
  return (h * 60) + m;
};