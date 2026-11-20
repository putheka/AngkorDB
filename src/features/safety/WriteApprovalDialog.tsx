import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useApprovalStore } from "@/features/safety/approval";

/** The question of Confirm mode. Cancel is the default answer; Esc and clicking away say no. */
export function WriteApprovalDialog() {
  const request = useApprovalStore((s) => s.request);
  const answer = useApprovalStore((s) => s.answer);

  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            This connection asks before it changes anything.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 list-disc space-y-1 overflow-y-auto rounded-md border bg-muted/30 py-2 pr-3 pl-6 font-mono text-xs break-all">
          {request?.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
