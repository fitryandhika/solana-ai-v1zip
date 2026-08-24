import AiHistoryDashboard from "../../components/AiHistoryDashboard";

export default function AiHistoryPage() {
  return (
    <>
      <header className="header">
        <div className="header-title">RIWAYAT AI</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Experimental — not financial advice</div>
      </header>
      <AiHistoryDashboard />
    </>
  );
}
