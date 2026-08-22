import Dashboard from "../components/Dashboard";

export default function HomePage() {
  return (
    <>
      <header className="header">
        <div className="header-title">SOLANA AI</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Experimental — not financial advice</div>
      </header>
      <Dashboard />
    </>
  );
}
