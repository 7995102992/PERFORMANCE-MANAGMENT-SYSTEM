package com.sentrifugo.pms.utils;

import com.sentrifugo.common.exception.DomainException;
import com.sentrifugo.security.context.PmsUserPrincipal;

import java.util.UUID;

/** Reads the organisation scope off the authenticated principal; it is never taken from a request. */
public final class PmsPrincipals {

    private PmsPrincipals() {
    }

    /**
     * PMS entities key organisations by UUID while the session carries IAM's id as a string, so a session whose
     * organisation id is absent or not a UUID cannot be scoped and is refused rather than guessed at.
     */
    public static UUID organisationId(PmsUserPrincipal user) {
        String raw = user == null ? null : user.organisationId();
        if (raw == null || raw.isBlank()) {
            throw DomainException.forbidden("The session has no organisation.", "PMS_INVALID_ORGANISATION");
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException e) {
            throw DomainException.forbidden("The organisation id on the session is not valid for PMS.",
                    "PMS_INVALID_ORGANISATION");
        }
    }
}
