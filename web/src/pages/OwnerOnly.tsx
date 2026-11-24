import { useBoard } from "../board";
import { Link } from "../router";

export function OwnerOnly({ what }: { what: string }) {
  const { board } = useBoard();
  return (
    <div className="page-section narrow">
      <h1 className="page-title">Owner only</h1>
      <p className="muted">Only the board owner, {board.owner.display_name}, can manage {what}.</p>
      <Link to={`/b/${board.id}`} className="button">
        Back to threads
      </Link>
    </div>
  );
}
