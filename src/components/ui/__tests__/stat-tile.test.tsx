// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { StatTile } from '@/components/ui/stat-tile';

// Regression coverage for the FS-8 shared <StatTile>, which consolidates the
// three hand-rolled KPI tiles (SummaryStrip, Portfolio KpiTile, FirmDashboard
// stat()). Pins the three shapes those callers rely on:
//   - static tile: label / value / sub, no click affordance (Portfolio, Firm)
//   - icon tile: leading icon renders next to the label (FirmDashboard)
//   - interactive tile: whole card is clickable + shows the affordance, and the
//     top-right `trailing` slot's own click does NOT bubble to the card onClick
//     (SummaryStrip's dismiss button).

afterEach(cleanup);

const AFFORDANCE = '.lucide-arrow-up-right';

describe('StatTile (FS-8)', () => {
  it('renders label, value, and sub for a static tile with no affordance', () => {
    const { container } = render(
      <StatTile label="Monthly Rent" value="$215.8K" sub="Avg $2.05/sqft" />,
    );
    expect(screen.getByText('Monthly Rent')).toBeTruthy();
    expect(screen.getByText('$215.8K')).toBeTruthy();
    expect(screen.getByText('Avg $2.05/sqft')).toBeTruthy();
    // Static tile: no clickable affordance.
    expect(container.querySelector(AFFORDANCE)).toBeNull();
  });

  it('renders a leading icon next to the label (FirmDashboard variant)', () => {
    render(
      <StatTile
        icon={<svg data-testid="firm-icon" />}
        label="Active leases"
        value={42}
      />,
    );
    expect(screen.getByTestId('firm-icon')).toBeTruthy();
    expect(screen.getByText('Active leases')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('sets the native title on the value (Portfolio full-figure-on-hover)', () => {
    render(<StatTile label="Occupancy" value="$2.6M" valueTitle="$2,600,000" />);
    expect(screen.getByText('$2.6M').getAttribute('title')).toBe('$2,600,000');
  });

  it('is a clickable card with an affordance when onClick is set', () => {
    const onClick = vi.fn();
    const { container } = render(
      <StatTile label="Needs Action" value={3} onClick={onClick} />,
    );
    expect(container.querySelector(AFFORDANCE)).not.toBeNull();
    // The whole card is the click target.
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies the accent tint class', () => {
    const { container } = render(
      <StatTile label="Needs Action" value={3} accent="blue" onClick={() => {}} />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('border-blue-200');
  });

  it('renders a trailing slot whose click does not bubble to the card onClick', () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <StatTile
        label="Expiring"
        value={5}
        onClick={onClick}
        trailing={
          <button
            type="button"
            aria-label="dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
          />
        }
      />,
    );
    fireEvent.click(screen.getByLabelText('dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // stopPropagation: the card's navigation onClick must NOT fire.
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is keyboard-operable when interactive (role, tabindex, Enter/Space)', () => {
    const onClick = vi.fn();
    const { container } = render(
      <StatTile label="Needs Action" value={3} onClick={onClick} />,
    );
    const card = container.firstChild as HTMLElement;
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is not a button and not focusable when static', () => {
    const { container } = render(<StatTile label="Monthly Rent" value="$215.8K" />);
    const card = container.firstChild as HTMLElement;
    expect(card.getAttribute('role')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
  });

  it('sets the native title on the label (hover-reveal for a truncated label)', () => {
    render(
      <StatTile
        label="Annual Occupancy Cost"
        labelTitle="Annual Occupancy Cost"
        value="$2.6M"
      />,
    );
    expect(screen.getByText('Annual Occupancy Cost').getAttribute('title')).toBe(
      'Annual Occupancy Cost',
    );
  });
});
