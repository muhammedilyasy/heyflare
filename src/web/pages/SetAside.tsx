import { Bookmark } from "lucide-react";
import { useImbox } from "../api";
import { useAccount } from "../context/AccountContext";
import { ConnectGmailCard } from "./Imbox";
import { ThreadList } from "../components/ThreadList";
import { PageHeader } from "../components/EmptyState";

export default function SetAside() {
  const { accounts } = useAccount();
  const imbox = useImbox(accounts.length > 0);
  if (accounts.length === 0) return <ConnectGmailCard />;
  const list = imbox.data?.set_aside ?? [];
  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader className="px-2" title="Set Aside" subtitle={list.length ? `${list.length} set aside. Things you want close at hand.` : "Things you want close at hand. Confirmations, links, reference numbers."} />
      <ThreadList
        showBucket
        loading={imbox.isLoading}
        error={imbox.error}
        onRetry={() => imbox.refetch()}
        emptyIcon={<Bookmark />}
        sections={[{ threads: list, emptyTitle: "Nothing set aside.", emptyBody: "Press a on any thread to keep it handy here." }]}
      />
    </div>
  );
}
