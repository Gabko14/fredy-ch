/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Flatfox.ch provider for Fredy
 * Swiss real estate platform owned by SMG (free for landlords)
 *
 * Uses Flatfox public API instead of HTML scraping for reliability.
 */

import { buildHash, isOneOf } from '../utils.js';

let appliedBlackList = [];

/**
 * Extract search parameters from user-provided URL.
 * Example URL: https://www.flatfox.ch/en/search/?east=7.533549&north=47.024424&object_category=APARTMENT&offer_type=RENT&south=46.909588&west=7.318974
 */
function parseSearchUrl(url) {
  const urlObj = new URL(url);
  const params = {};

  // Extract all search parameters
  for (const [key, value] of urlObj.searchParams) {
    params[key] = value;
  }

  return params;
}

/**
 * Fetch listing IDs from the pin API (map markers).
 */
async function fetchListingIds(params) {
  const apiUrl = new URL('https://flatfox.ch/api/v1/pin/');

  // Required geo params
  if (params.east) apiUrl.searchParams.set('east', params.east);
  if (params.west) apiUrl.searchParams.set('west', params.west);
  if (params.north) apiUrl.searchParams.set('north', params.north);
  if (params.south) apiUrl.searchParams.set('south', params.south);

  // Filter params
  if (params.object_category) apiUrl.searchParams.set('object_category', params.object_category);
  if (params.offer_type) apiUrl.searchParams.set('offer_type', params.offer_type);

  // Rooms filter - API uses min_rooms/max_rooms
  if (params.min_rooms) apiUrl.searchParams.set('min_rooms', params.min_rooms);
  if (params.max_rooms) apiUrl.searchParams.set('max_rooms', params.max_rooms);

  // Price filter - API uses min_price/max_price
  if (params.min_price) apiUrl.searchParams.set('min_price', params.min_price);
  if (params.max_price) apiUrl.searchParams.set('max_price', params.max_price);

  // Additional filters
  if (params.attribute) apiUrl.searchParams.set('attribute', params.attribute);
  if (params.moving_date_from) apiUrl.searchParams.set('moving_date_from', params.moving_date_from);
  if (params.is_swap) apiUrl.searchParams.set('is_swap', params.is_swap);
  if (params.ordering) apiUrl.searchParams.set('ordering', params.ordering);

  // Limit results (website uses 400)
  apiUrl.searchParams.set('max_count', '400');

  const response = await fetch(apiUrl.toString());
  if (!response.ok) {
    throw new Error(`Flatfox pin API error: ${response.status}`);
  }

  const pins = await response.json();
  return pins.map((pin) => pin.pk);
}

/**
 * Filter listings based on user's search parameters.
 * The pin API doesn't always respect price/rooms filters perfectly, so we filter client-side as backup.
 */
function filterListings(listings, params) {
  const minRooms = parseFloat(params.min_rooms || 0);
  const maxRooms = parseFloat(params.max_rooms || Infinity);
  const minPrice = parseFloat(params.min_price || 0);
  const maxPrice = parseFloat(params.max_price || Infinity);

  return listings.filter((item) => {
    const rooms = item.number_of_rooms || 0;
    const price = item.price_display || 0;

    if (rooms < minRooms || rooms > maxRooms) return false;
    if (price < minPrice || price > maxPrice) return false;

    return true;
  });
}

/**
 * Fetch full listing details from the public-listing API.
 * Batches requests to avoid URL length limits and API constraints.
 */
async function fetchListingDetails(pks) {
  if (pks.length === 0) return [];

  // Batch size: Flatfox API can handle ~50 PKs per request safely
  // Smaller batches are more reliable but require more requests
  const BATCH_SIZE = 20;
  const allListings = [];

  // Split PKs into batches
  for (let i = 0; i < pks.length; i += BATCH_SIZE) {
    const batch = pks.slice(i, i + BATCH_SIZE);

    const apiUrl = new URL('https://flatfox.ch/api/v1/public-listing/');
    apiUrl.searchParams.set('expand', 'cover_image');
    apiUrl.searchParams.set('limit', '0'); // No pagination limit

    // Add batch PKs as query params
    batch.forEach((pk) => apiUrl.searchParams.append('pk', pk));

    try {
      const response = await fetch(apiUrl.toString());
      if (!response.ok) {
        console.error(`Flatfox public-listing API error for batch ${i / BATCH_SIZE + 1}: ${response.status}`);
        continue; // Skip failed batch, continue with others
      }

      const data = await response.json();

      // API returns array directly, not wrapped in {results: [...]}
      const listings = Array.isArray(data) ? data : (data.results || []);
      allListings.push(...listings);

      console.log(`Fetched ${listings.length}/${batch.length} listings from batch ${i / BATCH_SIZE + 1}`);
    } catch (error) {
      console.error(`Error fetching batch ${i / BATCH_SIZE + 1}:`, error.message);
      // Continue with next batch
    }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < pks.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log(`Total listings fetched: ${allListings.length}/${pks.length} requested`);
  return allListings;
}

/**
 * Map API response to Fredy listing format.
 */
function mapApiToListing(item) {
  const pk = String(item.pk);
  const price = item.price_display ? `${item.price_display.toLocaleString('de-CH')} CHF` : '';

  // Build rooms/size string
  const rooms = item.number_of_rooms || '';
  const livingSpace = item.surface_living ? `${item.surface_living} m²` : '';
  const size = [rooms ? `${rooms} rooms` : '', livingSpace].filter(Boolean).join(', ');

  // Build image URL
  let image = '';
  if (item.cover_image?.url_listing_search) {
    image = `https://flatfox.ch${item.cover_image.url_listing_search}`;
  }

  return {
    id: pk,
    price: price,
    size: size,
    title: item.short_title || item.pitch_title || '',
    link: `https://www.flatfox.ch${item.url}`,
    description: item.description_title || item.description?.substring(0, 200) || '',
    address: item.public_address || '',
    image: image,
  };
}

/**
 * Custom getListings function that uses Flatfox API.
 * This replaces the default HTML scraper.
 */
async function getListings(url) {
  try {
    // Parse the user's search URL
    const params = parseSearchUrl(url);

    // Fetch listing IDs from pin API
    const pks = await fetchListingIds(params);
    console.log(`Flatfox: Found ${pks.length} listings from pin API`);

    if (pks.length === 0) {
      console.log('Flatfox: No listings found in search area');
      return [];
    }

    // Fetch full details for each listing (batched)
    const listings = await fetchListingDetails(pks);
    console.log(`Flatfox: Fetched details for ${listings.length}/${pks.length} listings`);

    // Warn if we didn't get all listings
    if (listings.length < pks.length) {
      console.warn(`Flatfox: Missing ${pks.length - listings.length} listings (possibly removed or API error)`);
    }

    // Filter by price/rooms (pin API doesn't support these filters)
    const filtered = filterListings(listings, params);
    console.log(`Flatfox: ${filtered.length} listings after filtering`);

    // Map to Fredy format
    return filtered.map(mapApiToListing);
  } catch (error) {
    console.error('Flatfox API error:', error);
    return [];
  }
}

function normalize(o) {
  // ID is already the pk from API, create hash with price for dedup
  const id = buildHash(o.id, o.price);
  return Object.assign(o, { id });
}

function applyBlacklist(o) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  return o.title != null && titleNotBlacklisted && descNotBlacklisted;
}

const config = {
  url: null,
  // These are not used when getListings is provided, but kept for compatibility
  crawlContainer: null,
  sortByDateParam: null,
  waitForSelector: null,
  crawlFields: {
    id: '',
    price: '',
    size: '',
    title: '',
    link: '',
    description: '',
    address: '',
    image: '',
  },
  normalize: normalize,
  filter: applyBlacklist,
  getListings: getListings,
};

export const init = (sourceConfig, blacklist) => {
  config.enabled = sourceConfig.enabled;
  config.url = sourceConfig.url;
  appliedBlackList = blacklist || [];
};

export const metaInformation = {
  name: 'Flatfox',
  baseUrl: 'https://flatfox.ch/',
  id: 'flatfox',
};

export { config };
