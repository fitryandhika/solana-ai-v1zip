import Watchlist from "../../components/Watchlist";

export default function WatchlistPage() {
  return (
    <>
      <header className="header">
        <div className="header-title">WATCHLIST</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Experimental — not financial advice</div>
      </header>
      <Watchlist />
    </>
  );
}
