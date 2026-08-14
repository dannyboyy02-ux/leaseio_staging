// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SectionCard } from '@/components/ui/section-card';

// Regression coverage for the FS-8 shared <SectionCard>, adopted by the five
// dashboard section cards (Recent Activity, Upcoming Risks, Lease Pipeline,
// Pipeline by Department, Intake Trend). Pins the contract those callers rely on:
//   - title + children render
//   - the icon renders at a FIXED h-4/w-4 (the size can't drift), with color
//     inheriting by default and overridable via iconClassName (amber theme)
//   - the right-aligned action slot renders (view-all links, the dept toggle)
//   - className / contentClassName pass through to Card / CardContent

afterEach(cleanup);

// A stub icon that echoes the className the primitive passes it.
function StubIcon({ className }: { className?: string }) {
  return <svg data-testid="icon" data-cls={className} />;
}

describe('SectionCard (FS-8)', () => {
  it('renders the title and children', () => {
    render(
      <SectionCard title="Recent Activity">
        <div>body content</div>
      </SectionCard>,
    );
    expect(screen.getByText('Recent Activity')).toBeTruthy();
    expect(screen.getByText('body content')).toBeTruthy();
  });

  it('renders the icon at a fixed h-4/w-4 size (color inherits by default)', () => {
    render(<SectionCard title="Intake" icon={StubIcon}>x</SectionCard>);
    const cls = screen.getByTestId('icon').getAttribute('data-cls') ?? '';
    expect(cls).toContain('h-4');
    expect(cls).toContain('w-4');
    // No default color class — the icon inherits (matches the dashboard cards).
    expect(cls).not.toContain('text-muted-foreground');
  });

  it('applies an icon color override without dropping the fixed size', () => {
    render(
      <SectionCard title="Upcoming Risks" icon={StubIcon} iconClassName="text-amber-500">
        x
      </SectionCard>,
    );
    const cls = screen.getByTestId('icon').getAttribute('data-cls') ?? '';
    expect(cls).toContain('h-4');
    expect(cls).toContain('text-amber-500');
  });

  it('renders the right-aligned action slot', () => {
    render(
      <SectionCard title="Lease Pipeline" action={<button>Full pipeline</button>}>
        x
      </SectionCard>,
    );
    expect(screen.getByText('Full pipeline')).toBeTruthy();
  });

  it('passes className onto the Card and contentClassName onto the content', () => {
    const { container } = render(
      <SectionCard title="Risks" className="border-amber-200" contentClassName="pt-0">
        <div>body</div>
      </SectionCard>,
    );
    // Outermost element is the Card.
    expect((container.firstChild as HTMLElement).className).toContain('border-amber-200');
    // The content wrapper carrying the override holds the children.
    const content = container.querySelector('.pt-0');
    expect(content).not.toBeNull();
    expect(content!.textContent).toContain('body');
  });
});
