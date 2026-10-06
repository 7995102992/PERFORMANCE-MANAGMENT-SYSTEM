package com.sentrifugo.security.access;

import org.springframework.security.access.prepost.PreAuthorize;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Requires the caller to hold {@code action} on {@code module} in IAM's
 * permission grid. Super admins and org admins bypass. Equivalent of
 * {@code Depends(require_permission(module, action))} in the Python services.
 *
 * <pre>
 * &#64;RequirePermission(module = "performance_management", action = "create_resource")
 * </pre>
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@PreAuthorize("@permissionGuard.has('{module}', '{action}')")
public @interface RequirePermission {

    String module();

    String action();
}
