import { useToast } from "@/hooks/use-toast";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";

function safeRender(node: unknown): React.ReactNode {
  if (node == null) {
    return null;
  }

  if (typeof node === "string" || typeof node === "number") {
    return node;
  }

  if (typeof node === "boolean") {
    return node ? "true" : "false";
  }

  if (Array.isArray(node)) {
    return node.map(safeRender);
  }

  if (typeof node === "object" && "$$typeof" in node) {
    return node as React.ReactNode;
  }

  try {
    return JSON.stringify(node);
  } catch {
    return String(node);
  }
}

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{safeRender(title)}</ToastTitle>}
              {description && <ToastDescription>{safeRender(description)}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
