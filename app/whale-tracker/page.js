import WhaleTracker from "../../components/WhaleTracker";

export default function WhaleTrackerPage() {
  return (
    <>
      <header className="header">
        <div className="header-title">WHALE TRACKER</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Experimental — not financial advice</div>
      </header>
      <WhaleTracker />
    </>
  );
}
