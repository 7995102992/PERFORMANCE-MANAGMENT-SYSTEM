package com.sentrifugo.common.exception;

import org.springframework.http.HttpStatus;

/**
 * A business-rule failure with a machine-readable {@code code} the frontend
 * branches on (never on {@code detail}).
 */
public class DomainException extends RuntimeException {

    private final String code;
    private final HttpStatus status;

    public DomainException(String message, String code, HttpStatus status) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public String getCode() {
        return code;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public static DomainException notFound(String message, String code) {
        return new DomainException(message, code, HttpStatus.NOT_FOUND);
    }

    public static DomainException conflict(String message, String code) {
        return new DomainException(message, code, HttpStatus.CONFLICT);
    }

    public static DomainException unprocessable(String message, String code) {
        return new DomainException(message, code, HttpStatus.UNPROCESSABLE_CONTENT);
    }

    public static DomainException badRequest(String message, String code) {
        return new DomainException(message, code, HttpStatus.BAD_REQUEST);
    }

    public static DomainException forbidden(String message, String code) {
        return new DomainException(message, code, HttpStatus.FORBIDDEN);
    }
}
