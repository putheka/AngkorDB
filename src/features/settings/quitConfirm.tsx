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
import { useQuitConfirm } from "@/stores/quitConfirm";

/** "Quit AngkorDB?", asked when "Confirm on quit" is on and nothing is unsaved. */
export function QuitConfirmDialog() {
  const open = useQuitConfirm((s) => s.open);
  const answer = useQuitConfirm((s) => s.answer);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && answer(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Quit AngkorDB?</AlertDialogTitle>
          <AlertDialogDescription>
            Open connections are closed. Your tabs come back the next time you open this connection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>Quit</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
