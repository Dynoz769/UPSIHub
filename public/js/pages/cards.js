// Card renderers shared by several pages.
import { state, esc, rm, icon, cover, listingCover, timeAgo, fmtDay, fmtTime } from '../core.js';

export function shopCard(s) {
  return `
    <article class="card shop-card" data-act="openShop" data-id="${s.id}" tabindex="0">
      <div class="cover">
        ${cover(s)}
        <span class="badge b-left"><span class="bullet" style="color:${s.is_open ? '#34d399' : '#fb7185'}"></span>${s.is_open ? 'Buka' : 'Tutup'}</span>
        <span class="badge b-right">${esc(s.campus)}</span>
      </div>
      <div class="body">
        <div class="eyebrow">${esc(s.category)}</div>
        <h3 class="clamp-1">${esc(s.name)}</h3>
        <p class="small muted clamp-2">${esc(s.description)}</p>
        <div class="shop-meta">
          <span>${icon('star', 'star')} ${s.reviews ? `<b>${s.rating.toFixed(1)}</b> (${s.reviews})` : 'Baharu'}</span>
          ${s.item_count != null ? `<span>${icon('package')} ${s.item_count} item${s.from_price != null ? ` · dari ${rm(s.from_price)}` : ''}</span>` : ''}
          <span>${icon('truck')} ${s.delivery_fee ? rm(s.delivery_fee) : 'Percuma'}</span>
        </div>
      </div>
    </article>`;
}

// One-line summary of a listing's kind-specific details.
export function listingSubtitle(l) {
  const M = state.config.listing_meta;
  if (l.kind === 'ROOM') return `${M.room_types[l.meta.room_type] || ''} · ${M.genders[l.meta.gender] || ''}`;
  if (l.kind === 'JOB') return `${esc(l.meta.employer || '')}`;
  if (l.kind === 'EVENT') return `${fmtDay(l.meta.event_at)}, ${fmtTime(l.meta.event_at)} · ${esc(l.meta.venue || '')}`;
  if (l.kind === 'LOST') return `${M.lost_types[l.meta.type] || ''} · ${esc(l.meta.date || '')}`;
  return `${esc(l.category || '')} · ${M.conditions[l.condition] || ''}`;
}
export function listingPrice(l) {
  const M = state.config.listing_meta;
  if (l.kind === 'LOST') return l.meta.type === 'FOUND' ? '<span class="badge green">Dijumpai</span>' : '<span class="badge red">Hilang</span>';
  if (l.price == null) return '';
  if (l.price === 0) return '<span class="price">Percuma</span>';
  const unit = l.kind === 'ROOM' ? '/bulan' : l.kind === 'JOB' ? `/${(M.pay_units[l.meta.pay_unit] || '').replace(/^se/, '')}` : '';
  return `<span class="price">${rm(l.price)}<span class="xs faint" style="font-weight:600">${unit}</span></span>`;
}

export function listingCard(l) {
  const flag = l.status === 'RESERVED' ? '<span class="badge b-left" style="background:rgba(217,119,6,.9)">Ditempah</span>'
    : l.status === 'SOLD' ? `<span class="badge b-left" style="background:rgba(225,29,72,.9)">${l.kind === 'EVENT' ? 'Habis dijual' : 'Terjual'}</span>` : '';
  return `
    <article class="card shop-card listing-card" data-act="openListing" data-id="${l.id}" tabindex="0">
      <div class="cover">${listingCover(l)}${flag}${l.negotiable ? '<span class="badge b-right">Boleh runding</span>' : ''}</div>
      <div class="body">
        ${listingPrice(l)}
        <h3 class="clamp-2" style="font-size:15px">${esc(l.title)}</h3>
        <div class="xs muted clamp-1">${listingSubtitle(l)}</div>
        <div class="shop-meta xs"><span>${icon('pin')} ${esc(l.location || l.campus)}</span><span>${timeAgo(l.created_at)}</span></div>
      </div>
    </article>`;
}
