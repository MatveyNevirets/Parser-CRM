import { classifyDuplicates } from "./deduplicate.js";
/**
 * Only an explicit shared network ID is enough to auto-confirm a branch group.
 * Other combinations of signals produce a review group; names alone never group records.
 */
export function classifyBranchGroups(candidates) {
    const duplicates = classifyDuplicates(candidates);
    const unique = duplicates.filter((row) => !row.duplicateOfId).map((row) => row.candidate);
    const edges = [];
    const networkBuckets = new Map();
    for (const candidate of unique) {
        if (!candidate.sourceNetworkId)
            continue;
        const key = `${candidate.source}:${candidate.sourceNetworkId}`;
        const bucket = networkBuckets.get(key) ?? [];
        bucket.push(candidate);
        networkBuckets.set(key, bucket);
    }
    for (const bucket of networkBuckets.values()) {
        for (let i = 0; i < bucket.length; i += 1) {
            for (let j = i + 1; j < bucket.length; j += 1) {
                edges.push({
                    left: bucket[i].candidateId,
                    right: bucket[j].candidateId,
                    classification: 'confirmed',
                    evidence: 'Совпадает идентификатор сети, предоставленный источником.',
                });
            }
        }
    }
    const signalBuckets = new Map();
    for (const candidate of unique) {
        for (const signal of [candidate.normalizedDomain && `domain:${candidate.normalizedDomain}`,
            candidate.normalizedPhone && `phone:${candidate.normalizedPhone}`]) {
            if (!signal)
                continue;
            const bucket = signalBuckets.get(signal) ?? [];
            bucket.push(candidate);
            signalBuckets.set(signal, bucket);
        }
    }
    const candidatePairs = new Map();
    for (const bucket of signalBuckets.values()) {
        for (let i = 0; i < bucket.length; i += 1) {
            for (let j = i + 1; j < bucket.length; j += 1) {
                const left = bucket[i];
                const right = bucket[j];
                const key = [left.candidateId, right.candidateId].sort().join('|');
                candidatePairs.set(key, [left, right]);
            }
        }
    }
    for (const [left, right] of candidatePairs.values()) {
        const evidence = inferBranchEvidence(left, right);
        if (evidence)
            edges.push({ left: left.candidateId, right: right.candidateId, classification: 'needs_review', evidence });
    }
    return connectedGroups(unique, edges);
}
export function nameSimilarity(left, right) {
    const leftTokens = new Set(left.split(' ').filter(Boolean));
    const rightTokens = new Set(right.split(' ').filter(Boolean));
    if (!leftTokens.size || !rightTokens.size)
        return 0;
    const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    return common / new Set([...leftTokens, ...rightTokens]).size;
}
function inferBranchEvidence(left, right) {
    const similarity = nameSimilarity(left.normalizedName, right.normalizedName);
    if (similarity < 0.72)
        return null;
    const distinctLocations = locationsDiffer(left, right);
    const sameDomain = Boolean(left.normalizedDomain && left.normalizedDomain === right.normalizedDomain);
    const samePhone = Boolean(left.normalizedPhone && left.normalizedPhone === right.normalizedPhone);
    if (sameDomain && distinctLocations)
        return 'Совпадают домен сайта и близкое название; адреса различаются.';
    if (samePhone && similarity >= 0.8 && distinctLocations)
        return 'Совпадают телефон и близкое название; адреса различаются.';
    if (sameDomain && similarity >= 0.85 && !left.normalizedAddress && !right.normalizedAddress) {
        return 'Совпадают домен и название, но адреса отсутствуют: требуется ручная проверка.';
    }
    return null;
}
function locationsDiffer(left, right) {
    if (left.latitude !== null && left.longitude !== null && right.latitude !== null && right.longitude !== null) {
        return distanceInMeters(left.latitude, left.longitude, right.latitude, right.longitude) > 250;
    }
    if (left.normalizedCity && right.normalizedCity && left.normalizedCity !== right.normalizedCity)
        return true;
    if (left.normalizedAddress && right.normalizedAddress && left.normalizedAddress !== right.normalizedAddress)
        return true;
    return false;
}
function distanceInMeters(lat1, lon1, lat2, lon2) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function connectedGroups(candidates, edges) {
    const adjacency = new Map();
    for (const edge of edges) {
        adjacency.set(edge.left, [...(adjacency.get(edge.left) ?? []), edge]);
        adjacency.set(edge.right, [...(adjacency.get(edge.right) ?? []), edge]);
    }
    const visited = new Set();
    const groups = [];
    for (const candidate of candidates) {
        if (visited.has(candidate.candidateId) || !adjacency.has(candidate.candidateId))
            continue;
        const memberIds = [];
        const groupEdges = [];
        const pending = [candidate.candidateId];
        visited.add(candidate.candidateId);
        while (pending.length) {
            const current = pending.pop();
            memberIds.push(current);
            for (const edge of adjacency.get(current) ?? []) {
                groupEdges.push(edge);
                const next = edge.left === current ? edge.right : edge.left;
                if (!visited.has(next)) {
                    visited.add(next);
                    pending.push(next);
                }
            }
        }
        if (memberIds.length < 2)
            continue;
        const members = [...new Set(memberIds)].sort();
        groups.push({
            groupKey: `branch:${members.join(':')}`,
            memberIds: members,
            classification: groupEdges.some((edge) => edge.classification === 'confirmed') ? 'confirmed' : 'needs_review',
            evidence: [...new Set(groupEdges.map((edge) => edge.evidence))],
        });
    }
    return groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}
