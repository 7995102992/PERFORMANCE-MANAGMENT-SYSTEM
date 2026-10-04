package com.sentrifugo.common.web;

import com.sentrifugo.common.exception.ApiError;
import com.sentrifugo.common.exception.DomainException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.stream.Collectors;

/**
 * Maps every exception to the {@code {detail, code}} body the PMS API contract defines.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(DomainException.class)
    public ResponseEntity<ApiError> handleDomain(DomainException ex) {
        log.warn("Domain error code={} message={}", ex.getCode(), ex.getMessage());
        return ResponseEntity.status(ex.getStatus()).body(new ApiError(ex.getMessage(), ex.getCode()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> handleValidation(MethodArgumentNotValidException ex) {
        String detail = ex.getBindingResult().getFieldErrors().stream()
                .map(err -> err.getField() + ": " + err.getDefaultMessage())
                .collect(Collectors.joining("; "));
        if (detail.isBlank()) {
            detail = "Validation error";
        }
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_CONTENT).body(new ApiError(detail, "VALIDATION_ERROR"));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class,
            MissingServletRequestParameterException.class})
    public ResponseEntity<ApiError> handleBadRequest(Exception ex) {
        log.warn("Bad request: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(new ApiError("Malformed request", "BAD_REQUEST"));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ApiError> handleNotFound(NoResourceFoundException ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(new ApiError("Not found", "NOT_FOUND"));
    }

    /**
     * {@code @PreAuthorize} denials are thrown from inside the controller call, so without this
     * they would be caught by the catch-all below and turned into a 500. Rethrowing hands them to
     * Spring Security's own 401/403 handlers ({@code SecurityErrorHandler}).
     */
    @ExceptionHandler({AccessDeniedException.class, AuthenticationException.class})
    public void rethrowSecurity(Exception ex) throws Exception {
        throw ex;
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception ex) {
        log.error("Unhandled server exception", ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ApiError("An unexpected error occurred.", "INTERNAL_SERVER_ERROR"));
    }
}
