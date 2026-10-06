package com.sentrifugo.security.access;

import com.sentrifugo.security.context.PmsUserPrincipal;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/** Backs {@link RequirePermission}; also usable directly from service code. */
@Component("permissionGuard")
public class PermissionGuard {

    public boolean has(String module, String action) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof PmsUserPrincipal user)) {
            return false;
        }
        return user.isAdmin() || user.hasPermission(module, action);
    }
}
