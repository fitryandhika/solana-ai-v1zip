import Link from "next/link";
import TokenDetail from "../../../components/TokenDetail";

export default function TokenDetailPage({ params }) {
  return (
    <>
      <header className="header">
        <Link href="/" className="header-title">
          ← SOLANA AI
        </Link>
      </header>
      <TokenDetail address={params.address} />
    </>
  );
}
