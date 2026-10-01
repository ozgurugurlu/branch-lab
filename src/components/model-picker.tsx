"use client";

import {
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LockKeyhole } from "lucide-react";
import type { ModelConfig, ProviderStatus } from "@/lib/types";
import { providerUnavailableReason } from "@/lib/providers";

interface Props {
  value: ModelConfig;
  providers: ProviderStatus[];
  onChange: (model: ModelConfig) => void;
  disabled?: boolean;
  variant?: "compact" | "field";
}

export function ModelPicker({
  value,
  providers,
  onChange,
  disabled = false,
  variant = "compact",
}: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({
    visibility: "hidden",
  });
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const options = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const selectedIndex = options.findIndex(
    (option) =>
      option.provider.id === value.provider && option.model.id === value.model,
  );
  const selected = options[selectedIndex];
  const name = selected?.model.name ?? value.model;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function show(direction: "first" | "last" | "selected" = "selected") {
    if (disabled) return;
    // Every opening is measured afresh before paint, including after viewport changes.
    setPosition({ visibility: "hidden" });
    setPortalTarget(
      trigger.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body,
    );
    setActive(
      direction === "last"
        ? options.length - 1
        : direction === "first"
          ? 0
          : Math.max(0, selectedIndex),
    );
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || !option.provider.configured) return;
    onChange({ provider: option.provider.id, model: option.model.id });
    close(true);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && !open) return;
    if (
      ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(
        event.key,
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      close(true);
      return;
    }
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "Enter" ||
        event.key === " "
      )
        show();
      if (event.key === "ArrowUp") show("last");
      if (event.key === "Home") show("first");
      if (event.key === "End") show("last");
      return;
    }
    if (event.key === "ArrowDown")
      setActive((index) => Math.min(options.length - 1, index + 1));
    if (event.key === "ArrowUp") setActive((index) => Math.max(0, index - 1));
    if (event.key === "Home") setActive(0);
    if (event.key === "End") setActive(options.length - 1);
    if (event.key === "Enter" || event.key === " ") choose(active);
  }
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const width = Math.min(360, viewportWidth - 24);
      const below = viewportTop + viewportHeight - box.bottom - 12;
      const above = box.top - viewportTop - 12;
      const useAbove = below < 300 && above > below;
      const height = Math.min(
        450,
        viewportHeight - 24,
        Math.max(80, useAbove ? above - 7 : below - 7),
      );
      setPosition({
        position: "fixed",
        width,
        maxHeight: height,
        left: Math.max(
          viewportLeft + 12,
          Math.min(
            box.right - width,
            viewportLeft + viewportWidth - width - 12,
          ),
        ),
        ...(useAbove
          ? { bottom: window.innerHeight - box.top + 7, top: "auto" }
          : { top: box.bottom + 7, bottom: "auto" }),
        visibility: "visible",
      });
    };
    place();
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (open && position.visibility === "visible")
      optionRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open, position.maxHeight, position.visibility]);

  let optionIndex = 0;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-describedby={`${id}-selected`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        disabled={disabled}
        className={`model-picker-trigger ${variant}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={keyDown}
      >
        <span>{name}</span>
        <ChevronDown size={13} className={open ? "is-open" : ""} />
      </button>
      <span id={`${id}-selected`} className="sr-only">
        Selected model: {name}
      </span>
      {open &&
        portalTarget &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="listbox"
            aria-label="Models"
            className="model-picker-popover"
            style={position}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="model-picker-heading">
              Choose a model<span>Available in this workspace</span>
            </div>
            {providers.map((provider) => (
              <div
                role="group"
                aria-label={provider.name}
                key={provider.id}
                className="model-picker-group"
              >
                <div className="model-picker-provider">
                  {provider.name}
                  {!provider.configured && (
                    <span>
                      <LockKeyhole size={10} />
                      Not configured
                    </span>
                  )}
                </div>
                {!provider.configured && (
                  <p
                    className="model-picker-unavailable"
                    id={`${id}-reason-${provider.id}`}
                  >
                    {providerUnavailableReason(provider)}
                  </p>
                )}
                {provider.models.map((model) => {
                  const index = optionIndex++;
                  const isSelected =
                    provider.id === value.provider && model.id === value.model;
                  return (
                    <div
                      key={model.id}
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                      id={`${id}-option-${index}`}
                      role="option"
                      aria-label={model.name}
                      aria-selected={isSelected}
                      aria-disabled={!provider.configured}
                      aria-describedby={`${id}-description-${index}${!provider.configured ? ` ${id}-reason-${provider.id}` : ""}`}
                      className={`model-picker-option ${index === active ? "is-active" : ""} ${isSelected ? "is-selected" : ""}`}
                      onPointerMove={() => setActive(index)}
                      onClick={() => choose(index)}
                    >
                      <div>
                        <span>
                          {model.name}
                          {model.preview && <small>Preview</small>}
                        </span>
                        {isSelected && <Check size={14} />}
                      </div>
                      <p id={`${id}-description-${index}`}>
                        {model.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="model-picker-footer">
              Local servers and API keys are managed in Settings.
            </div>
          </div>,
          portalTarget,
        )}
    </>
  );
}
