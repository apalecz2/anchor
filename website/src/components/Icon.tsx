import React from 'react';

export interface IconProps {
    /** Material Symbols glyph name, e.g. "download" (see fonts.google.com/icons). */
    name: string;
    /** Font size in px. Omit to inherit the surrounding font size. */
    size?: number;
    /** FILL axis: 0 = outlined, 1 = filled. Omit to use the font default. */
    fill?: 0 | 1;
    /** Optical weight (`wght`) axis, e.g. 300. Omit to use the font default. */
    weight?: number;
    /** Extra classes for colour, animation, or layout (e.g. "text-primary animate-spin"). */
    className?: string;
    /** Decorative by default; pass `false` only when the glyph itself is the label. */
    'aria-hidden'?: boolean;
}

/**
 * Material Symbols icon span, copied verbatim from the Anchor app
 * (app/src/components/Icon.tsx) so glyphs render identically to the product.
 */
export function Icon({
    name,
    size,
    fill,
    weight,
    className = '',
    'aria-hidden': ariaHidden = true,
}: IconProps): React.ReactElement {
    const axes: string[] = [];
    if (fill !== undefined) axes.push(`'FILL' ${fill}`);
    if (weight !== undefined) axes.push(`'wght' ${weight}`);

    const style: React.CSSProperties = {};
    if (size !== undefined) style.fontSize = `${size}px`;
    if (axes.length) style.fontVariationSettings = axes.join(', ');

    return (
        <span
            className={className ? `material-symbols-outlined ${className}` : 'material-symbols-outlined'}
            style={style}
            aria-hidden={ariaHidden}
        >
            {name}
        </span>
    );
}

export default Icon;
