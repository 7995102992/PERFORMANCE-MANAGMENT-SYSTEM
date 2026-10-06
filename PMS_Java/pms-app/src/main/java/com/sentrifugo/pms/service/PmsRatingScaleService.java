package com.sentrifugo.pms.service;

import com.sentrifugo.common.exception.DomainException;
import com.sentrifugo.db.dto.PmsRatingScaleDTO;
import com.sentrifugo.db.dto.PmsRatingScaleLevelDTO;
import com.sentrifugo.db.entity.PmsRatingScaleEntity;
import com.sentrifugo.db.entity.PmsRatingScaleLevelEntity;
import com.sentrifugo.db.enums.PmsMasterStatus;
import com.sentrifugo.db.mapper.PmsRatingScaleLevelMapper;
import com.sentrifugo.db.mapper.PmsRatingScaleMapper;
import com.sentrifugo.db.repository.PmsRatingScaleLevelRepository;
import com.sentrifugo.db.repository.PmsRatingScaleRepository;
import com.sentrifugo.pms.model.PmsRatingScaleRequest;
import com.sentrifugo.pms.model.PmsRatingScaleResponse;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Rating scales for the cycle wizard dropdown (screen 1.5) and the rating-scale configuration (screen 2.10). */
@Service
@RequiredArgsConstructor
public class PmsRatingScaleService {

    private static final Logger log = LoggerFactory.getLogger(PmsRatingScaleService.class);

    private final PmsRatingScaleRepository scaleRepository;
    private final PmsRatingScaleLevelRepository levelRepository;
    private final PmsRatingScaleMapper scaleMapper;
    private final PmsRatingScaleLevelMapper levelMapper;

    @Transactional(readOnly = true)
    public List<PmsRatingScaleResponse> getRatingScales(String organisationId, String status) {
        PmsMasterStatus filter = status == null || status.isBlank() ? null : parseStatus(status);
        return scaleRepository.findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(organisationId).stream()
                .filter(s -> filter == null || s.getStatus() == filter)
                .map(this::toResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public PmsRatingScaleResponse getRatingScale(String organisationId, UUID scaleId) {
        return toResponse(find(organisationId, scaleId));
    }

    @Transactional
    public PmsRatingScaleResponse createRatingScale(String organisationId, PmsRatingScaleRequest request) {
        log.info("Creating rating scale for organisation {}", organisationId);
        validateLevels(request.levels());
        PmsRatingScaleEntity scale = scaleMapper.toEntity(PmsRatingScaleDTO.builder()
                .organisationId(organisationId)
                .name(request.name().trim())
                .description(request.description())
                .status(request.status() == null ? PmsMasterStatus.ACTIVE : parseStatus(request.status()))
                .isDefault(Boolean.TRUE.equals(request.isDefault()))
                .showDefinitionsToEmployees(request.showDefinitionsToEmployees() == null
                        || request.showDefinitionsToEmployees())
                .build());
        scale = scaleRepository.save(scale);
        clearOtherDefaults(organisationId, scale);
        saveLevels(scale, request.levels(), Map.of());
        return toResponse(scale);
    }

    /** Screen 2.10 "Save Scale": replaces the scale's settings and syncs its levels by rating value. */
    @Transactional
    public PmsRatingScaleResponse updateRatingScale(String organisationId, UUID scaleId,
                                                    PmsRatingScaleRequest request) {
        log.info("Updating rating scale {}", scaleId);
        PmsRatingScaleEntity scale = find(organisationId, scaleId);
        validateLevels(request.levels());

        scale.setName(request.name().trim());
        scale.setDescription(request.description());
        if (request.status() != null) {
            scale.setStatus(parseStatus(request.status()));
        }
        if (request.isDefault() != null) {
            scale.setIsDefault(request.isDefault());
        }
        if (request.showDefinitionsToEmployees() != null) {
            scale.setShowDefinitionsToEmployees(request.showDefinitionsToEmployees());
        }
        scale = scaleRepository.save(scale);
        clearOtherDefaults(organisationId, scale);

        Map<Integer, PmsRatingScaleLevelEntity> existing = new HashMap<>();
        levelRepository.findByRatingScaleIdOrderByRatingValueDesc(scaleId)
                .forEach(l -> existing.put(l.getRatingValue(), l));
        saveLevels(scale, request.levels(), existing);
        return toResponse(scale);
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** Only one scale per organisation may be the default for new cycles. */
    private void clearOtherDefaults(String organisationId, PmsRatingScaleEntity scale) {
        if (!Boolean.TRUE.equals(scale.getIsDefault())) {
            return;
        }
        for (PmsRatingScaleEntity other : scaleRepository.findByOrganisationIdAndIsDefaultTrue(organisationId)) {
            if (!other.getId().equals(scale.getId())) {
                other.setIsDefault(false);
                scaleRepository.save(other);
            }
        }
    }

    private void saveLevels(PmsRatingScaleEntity scale, List<PmsRatingScaleRequest.Level> levels,
                            Map<Integer, PmsRatingScaleLevelEntity> existing) {
        Set<Integer> kept = new HashSet<>();
        for (PmsRatingScaleRequest.Level level : levels) {
            kept.add(level.ratingValue());
            PmsRatingScaleLevelDTO dto = PmsRatingScaleLevelDTO.builder()
                    .ratingValue(level.ratingValue())
                    .label(level.label().trim())
                    .definition(level.definition())
                    .minimumScore(level.minimumScore())
                    .maximumScore(level.maximumScore())
                    .colourCode(level.colourCode())
                    .displayOrder(level.displayOrder())
                    .build();
            PmsRatingScaleLevelEntity row = existing.get(level.ratingValue());
            if (row == null) {
                row = levelMapper.toEntity(dto);
                row.setRatingScale(scale);
            } else {
                levelMapper.updateEntityFromDto(dto, row);
            }
            levelRepository.save(row);
        }
        existing.forEach((value, row) -> {
            if (!kept.contains(value)) {
                levelRepository.delete(row);
            }
        });
    }

    /** Rating values are unique, each range is ordered, and ranges of different levels do not overlap. */
    private void validateLevels(List<PmsRatingScaleRequest.Level> levels) {
        Set<Integer> seen = new HashSet<>();
        for (PmsRatingScaleRequest.Level level : levels) {
            if (!seen.add(level.ratingValue())) {
                throw DomainException.unprocessable("rating_value " + level.ratingValue() + " is listed more than once",
                        "VALIDATION_ERROR");
            }
            if (level.minimumScore().compareTo(level.maximumScore()) > 0) {
                throw DomainException.unprocessable("Level " + level.ratingValue()
                        + ": minimum_score must not exceed maximum_score", "VALIDATION_ERROR");
            }
        }
        List<PmsRatingScaleRequest.Level> ordered = levels.stream()
                .sorted(Comparator.comparing(PmsRatingScaleRequest.Level::minimumScore)).toList();
        for (int i = 1; i < ordered.size(); i++) {
            if (ordered.get(i).minimumScore().compareTo(ordered.get(i - 1).maximumScore()) <= 0) {
                throw DomainException.unprocessable("The score ranges of levels " + ordered.get(i - 1).ratingValue()
                        + " and " + ordered.get(i).ratingValue() + " overlap", "VALIDATION_ERROR");
            }
        }
    }

    private PmsRatingScaleEntity find(String organisationId, UUID scaleId) {
        return scaleRepository.findByIdAndOrganisationId(scaleId, organisationId)
                .filter(s -> Boolean.TRUE.equals(s.getIsActive()))
                .orElseThrow(() -> DomainException.notFound("Rating scale not found",
                        "PMS_RATING_SCALE_NOT_FOUND"));
    }

    private static PmsMasterStatus parseStatus(String value) {
        try {
            return PmsMasterStatus.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("status must be one of: active, inactive", "VALIDATION_ERROR");
        }
    }

    private PmsRatingScaleResponse toResponse(PmsRatingScaleEntity scale) {
        List<PmsRatingScaleResponse.Level> levels = levelRepository
                .findByRatingScaleIdOrderByRatingValueDesc(scale.getId()).stream()
                .map(l -> new PmsRatingScaleResponse.Level(l.getRatingValue(), l.getLabel(), l.getDefinition(),
                        l.getMinimumScore(), l.getMaximumScore(), l.getColourCode(), l.getDisplayOrder()))
                .toList();
        return new PmsRatingScaleResponse(scale.getId(), scale.getName(), scale.getDescription(),
                scale.getStatus().name().toLowerCase(Locale.ROOT), Boolean.TRUE.equals(scale.getIsDefault()),
                Boolean.TRUE.equals(scale.getShowDefinitionsToEmployees()), levels);
    }
}
