package com.sentrifugo.security.filter;

import com.sentrifugo.security.context.PmsUserPrincipal;
import com.sentrifugo.security.service.SessionService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Authenticates a request from its {@code Authorization: Bearer <token>} header
 * by looking the token up in the IAM session store.
 *
 * A missing or unusable token leaves the request unauthenticated rather than
 * rejecting it here, so public routes keep working; protected routes are then
 * refused with 401 by the security chain. The reason is stashed on the request
 * so the 401 body can say why.
 */
public class BearerTokenFilter extends OncePerRequestFilter {

    public static final String AUTH_FAILURE_ATTRIBUTE = BearerTokenFilter.class.getName() + ".failure";

    private static final String BEARER_PREFIX = "bearer ";

    private final SessionService sessionService;

    public BearerTokenFilter(SessionService sessionService) {
        this.sessionService = sessionService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String token = extractToken(request);
        if (token != null) {
            try {
                PmsUserPrincipal user = sessionService.resolve(token);
                SecurityContext context = SecurityContextHolder.createEmptyContext();
                context.setAuthentication(
                        UsernamePasswordAuthenticationToken.authenticated(user, token, authorities(user)));
                SecurityContextHolder.setContext(context);
            } catch (AuthenticationException e) {
                SecurityContextHolder.clearContext();
                request.setAttribute(AUTH_FAILURE_ATTRIBUTE, e);
            }
        }
        filterChain.doFilter(request, response);
    }

    private static String extractToken(HttpServletRequest request) {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.regionMatches(true, 0, BEARER_PREFIX, 0, BEARER_PREFIX.length())) {
            return null;
        }
        String token = header.substring(BEARER_PREFIX.length()).trim();
        return token.isEmpty() ? null : token;
    }

    private static List<GrantedAuthority> authorities(PmsUserPrincipal user) {
        List<GrantedAuthority> authorities = new ArrayList<>();
        if (user.superAdmin()) {
            authorities.add(new SimpleGrantedAuthority("ROLE_SUPER_ADMIN"));
        }
        if (user.orgAdmin()) {
            authorities.add(new SimpleGrantedAuthority("ROLE_ORG_ADMIN"));
        }
        return authorities;
    }
}
