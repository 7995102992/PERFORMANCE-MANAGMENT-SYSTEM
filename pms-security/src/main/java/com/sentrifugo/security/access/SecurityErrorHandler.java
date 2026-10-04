package com.sentrifugo.security.access;

import com.sentrifugo.security.filter.BearerTokenFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Writes 401 / 403 responses in the {@code {"detail", "code"}} shape the
 * Python services return, so the frontend handles PMS errors the same way.
 */
@Component
public class SecurityErrorHandler implements AuthenticationEntryPoint, AccessDeniedHandler {

    private final ObjectMapper objectMapper;

    public SecurityErrorHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void commence(HttpServletRequest request,
                         HttpServletResponse response,
                         AuthenticationException authException) throws IOException {
        Object failure = request.getAttribute(BearerTokenFilter.AUTH_FAILURE_ATTRIBUTE);
        String detail = failure instanceof AuthenticationException e ? e.getMessage() : "Missing bearer token";
        write(response, HttpStatus.UNAUTHORIZED, detail, "UNAUTHORIZED");
    }

    @Override
    public void handle(HttpServletRequest request,
                       HttpServletResponse response,
                       AccessDeniedException accessDeniedException) throws IOException {
        write(response, HttpStatus.FORBIDDEN, "You do not have permission to perform this action", "FORBIDDEN");
    }

    private void write(HttpServletResponse response, HttpStatus status, String detail, String code) throws IOException {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("detail", detail);
        body.put("code", code);
        response.setStatus(status.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(objectMapper.writeValueAsString(body));
    }
}
